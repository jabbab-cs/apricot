import AVFoundation
import CoreMedia
import UIKit
import VideoToolbox

/// Decodes an Annex-B H.264 stream (as produced by scrcpy) with VideoToolbox and shows each
/// picture on an AVSampleBufferDisplayLayer the moment it is decoded.
///
/// Decoding ourselves matters: when the layer is fed compressed frames it holds the newest one
/// back until the next arrives, so a screen that stops changing is shown one frame stale.
///
/// Not thread-safe: all calls except `layer` access happen on DeviceStream's decode queue.
final class H264Renderer: @unchecked Sendable {
    let layer = AVSampleBufferDisplayLayer()
    private var format: CMVideoFormatDescription?
    private var session: VTDecompressionSession?
    private var imageFormat: CMVideoFormatDescription?
    private var sps: Data?
    private var pps: Data?

    /// Called when the decoded picture size changes (e.g. after rotation).
    var onSizeChange: ((CGSize) -> Void)?

    init() {
        layer.videoGravity = .resizeAspect
        layer.backgroundColor = UIColor.black.cgColor
    }

    deinit {
        if let session { VTDecompressionSessionInvalidate(session) }
    }

    /// Returns false when decoding can't continue until a fresh key frame arrives.
    @discardableResult
    func decode(_ data: Data, isKeyFrame: Bool) -> Bool {
        var slices: [Data] = []
        var newSPS: Data?
        var newPPS: Data?
        for nal in Self.nalUnits(in: data) {
            guard let header = nal.first else { continue }
            switch header & 0x1F {
            case 7: newSPS = nal
            case 8: newPPS = nal
            case 1, 5: slices.append(nal)
            default: break // SEI, AUD, ...
            }
        }

        if let newSPS, let newPPS, newSPS != sps || newPPS != pps {
            sps = newSPS
            pps = newPPS
            guard makeFormat() else { return false }
            invalidateSession()
        }
        guard let format, !slices.isEmpty else { return format != nil }

        if session == nil {
            // A new decoder can only start from a key frame.
            guard isKeyFrame, makeSession(format: format) else { return false }
        }
        guard let session, let sample = Self.sampleBuffer(slices: slices, format: format) else { return false }

        // Synchronous decode: the output handler runs before this call returns.
        var ok = true
        let status = VTDecompressionSessionDecodeFrame(session, sampleBuffer: sample, flags: [], infoFlagsOut: nil) {
            [weak self] status, _, imageBuffer, _, _ in
            guard status == noErr, let imageBuffer else {
                ok = false
                return
            }
            self?.display(imageBuffer)
        }
        if status != noErr {
            // e.g. kVTInvalidSessionErr after the app was backgrounded
            invalidateSession()
            return false
        }
        return ok
    }

    func reset() {
        layer.sampleBufferRenderer.flush(removingDisplayedImage: true, completionHandler: nil)
        invalidateSession()
        format = nil
        sps = nil
        pps = nil
    }

    // MARK: Display

    private func display(_ imageBuffer: CVImageBuffer) {
        if imageFormat == nil || !CMVideoFormatDescriptionMatchesImageBuffer(imageFormat!, imageBuffer: imageBuffer) {
            var desc: CMVideoFormatDescription?
            CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: imageBuffer, formatDescriptionOut: &desc)
            imageFormat = desc
        }
        guard let imageFormat else { return }

        var timing = CMSampleTimingInfo(
            duration: .invalid,
            presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
            decodeTimeStamp: .invalid
        )
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: imageBuffer, formatDescription: imageFormat,
            sampleTiming: &timing, sampleBufferOut: &sample
        ) == noErr, let sample else { return }
        Self.markDisplayImmediately(sample)

        let renderer = layer.sampleBufferRenderer
        if renderer.status == .failed { renderer.flush() }
        renderer.enqueue(sample)
    }

    // MARK: Decoder setup

    private func makeFormat() -> Bool {
        guard let sps, let pps else { return false }
        var newFormat: CMVideoFormatDescription?
        let status = sps.withUnsafeBytes { (spsPtr: UnsafeRawBufferPointer) -> OSStatus in
            pps.withUnsafeBytes { (ppsPtr: UnsafeRawBufferPointer) -> OSStatus in
                let pointers: [UnsafePointer<UInt8>] = [
                    spsPtr.bindMemory(to: UInt8.self).baseAddress!,
                    ppsPtr.bindMemory(to: UInt8.self).baseAddress!,
                ]
                let sizes = [sps.count, pps.count]
                return CMVideoFormatDescriptionCreateFromH264ParameterSets(
                    allocator: kCFAllocatorDefault,
                    parameterSetCount: 2,
                    parameterSetPointers: pointers,
                    parameterSetSizes: sizes,
                    nalUnitHeaderLength: 4,
                    formatDescriptionOut: &newFormat
                )
            }
        }
        guard status == noErr, let newFormat else { return false }
        format = newFormat
        let size = CMVideoFormatDescriptionGetPresentationDimensions(newFormat, usePixelAspectRatio: true, useCleanAperture: true)
        onSizeChange?(size)
        return true
    }

    private func makeSession(format: CMVideoFormatDescription) -> Bool {
        let attributes: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferIOSurfacePropertiesKey: [CFString: Any](),
        ]
        var newSession: VTDecompressionSession?
        let status = VTDecompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            formatDescription: format,
            decoderSpecification: nil,
            imageBufferAttributes: attributes as CFDictionary,
            outputCallback: nil,
            decompressionSessionOut: &newSession
        )
        guard status == noErr, let newSession else { return false }
        VTSessionSetProperty(newSession, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        session = newSession
        return true
    }

    private func invalidateSession() {
        if let session { VTDecompressionSessionInvalidate(session) }
        session = nil
    }

    // MARK: Sample buffers

    private static func markDisplayImmediately(_ sample: CMSampleBuffer) {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true),
              CFArrayGetCount(attachments) > 0 else { return }
        let dict = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
        CFDictionarySetValue(
            dict,
            Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
            Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
        )
    }

    /// Wraps Annex-B slices as one AVCC (4-byte length-prefixed) compressed sample.
    private static func sampleBuffer(slices: [Data], format: CMVideoFormatDescription) -> CMSampleBuffer? {
        var avcc = Data(capacity: slices.reduce(0) { $0 + $1.count + 4 })
        for nal in slices {
            var length = UInt32(nal.count).bigEndian
            withUnsafeBytes(of: &length) { avcc.append(contentsOf: $0) }
            avcc.append(nal)
        }

        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: avcc.count,
            blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
            dataLength: avcc.count, flags: 0, blockBufferOut: &block
        ) == kCMBlockBufferNoErr, let block else { return nil }
        let copied = avcc.withUnsafeBytes { ptr in
            CMBlockBufferReplaceDataBytes(with: ptr.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: avcc.count)
        }
        guard copied == kCMBlockBufferNoErr else { return nil }

        var sample: CMSampleBuffer?
        var sampleSize = avcc.count
        guard CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
            sampleCount: 1, sampleTimingEntryCount: 0, sampleTimingArray: nil,
            sampleSizeEntryCount: 1, sampleSizeArray: &sampleSize, sampleBufferOut: &sample
        ) == noErr, let sample else { return nil }
        return sample
    }

    /// Splits an Annex-B byte stream on 00 00 01 / 00 00 00 01 start codes.
    static func nalUnits(in data: Data) -> [Data] {
        var units: [Data] = []
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let b = raw.bindMemory(to: UInt8.self)
            let n = b.count
            var i = 0
            var start = -1
            func emit(until end: Int) {
                var e = end
                while e > start, b[e - 1] == 0 { e -= 1 }
                if e > start { units.append(Data(UnsafeBufferPointer(rebasing: b[start..<e]))) }
            }
            while i + 2 < n {
                if b[i] == 0, b[i + 1] == 0, b[i + 2] == 1 {
                    if start >= 0 { emit(until: i) }
                    i += 3
                    start = i
                } else {
                    i += 1
                }
            }
            if start >= 0, start < n { emit(until: n) }
        }
        return units
    }
}
