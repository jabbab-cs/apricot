import AVFoundation
import SwiftUI
import UIKit

/// The live Android screen. Forwards multi-touch and the iOS keyboard to the device.
struct DeviceScreen: UIViewRepresentable {
    let stream: DeviceStream
    @Binding var keyboardActive: Bool

    func makeUIView(context: Context) -> DeviceSurfaceView {
        let view = DeviceSurfaceView()
        view.displayLayer = stream.renderer.layer
        view.onTouch = { [weak stream] action, id, point in stream?.touch(action, id: id, at: point) }
        view.onText = { [weak stream] text in stream?.text(text) }
        view.onKey = { [weak stream] key in stream?.key(key) }
        return view
    }

    func updateUIView(_ view: DeviceSurfaceView, context: Context) {
        view.videoSize = stream.videoSize
        let binding = $keyboardActive
        view.onKeyboardDismissed = {
            DispatchQueue.main.async { if binding.wrappedValue { binding.wrappedValue = false } }
        }
        if keyboardActive, !view.isFirstResponder {
            view.becomeFirstResponder()
        } else if !keyboardActive, view.isFirstResponder {
            view.resignFirstResponder()
        }
    }
}

final class DeviceSurfaceView: UIView, UIKeyInput {
    var displayLayer: CALayer? {
        didSet {
            oldValue?.removeFromSuperlayer()
            if let displayLayer { layer.addSublayer(displayLayer) }
            setNeedsLayout()
        }
    }

    var videoSize: CGSize = .zero
    var onTouch: ((String, Int, CGPoint) -> Void)?
    var onText: ((String) -> Void)?
    var onKey: ((String) -> Void)?
    var onKeyboardDismissed: (() -> Void)?

    private var pointerIds: [ObjectIdentifier: Int] = [:]

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        isMultipleTouchEnabled = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        displayLayer?.frame = bounds
        CATransaction.commit()
    }

    // MARK: Touch

    private var contentRect: CGRect {
        guard videoSize.width > 0, videoSize.height > 0 else { return bounds }
        return AVMakeRect(aspectRatio: videoSize, insideRect: bounds)
    }

    private func normalized(_ touch: UITouch) -> CGPoint {
        let p = touch.location(in: self)
        let r = contentRect
        return CGPoint(
            x: min(max((p.x - r.minX) / r.width, 0), 1),
            y: min(max((p.y - r.minY) / r.height, 0), 1)
        )
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches {
            let used = Set(pointerIds.values)
            let id = (0..<10).first { !used.contains($0) } ?? 0
            pointerIds[ObjectIdentifier(touch)] = id
            onTouch?("down", id, normalized(touch))
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches {
            guard let id = pointerIds[ObjectIdentifier(touch)] else { continue }
            onTouch?("move", id, normalized(touch))
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        finish(touches, action: "up")
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        finish(touches, action: "cancel")
    }

    private func finish(_ touches: Set<UITouch>, action: String) {
        for touch in touches {
            guard let id = pointerIds.removeValue(forKey: ObjectIdentifier(touch)) else { continue }
            onTouch?(action, id, normalized(touch))
        }
    }

    // MARK: Keyboard (UIKeyInput)

    override var canBecomeFirstResponder: Bool { true }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { onKeyboardDismissed?() }
        return resigned
    }

    var hasText: Bool { true }
    var autocorrectionType: UITextAutocorrectionType = .no
    var autocapitalizationType: UITextAutocapitalizationType = .none
    var spellCheckingType: UITextSpellCheckingType = .no
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartDashesType: UITextSmartDashesType = .no
    var keyboardAppearance: UIKeyboardAppearance = .dark

    func insertText(_ text: String) {
        if text == "\n" { onKey?("enter") } else { onText?(text) }
    }

    func deleteBackward() { onKey?("del") }

    // Hardware keyboard (iPad / Bluetooth) special keys
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var handled = false
        for press in presses {
            guard let key = press.key else { continue }
            let mapped: String? = switch key.keyCode {
            case .keyboardEscape: "back"
            case .keyboardUpArrow: "dpad_up"
            case .keyboardDownArrow: "dpad_down"
            case .keyboardLeftArrow: "dpad_left"
            case .keyboardRightArrow: "dpad_right"
            case .keyboardTab: "tab"
            default: nil
            }
            if let mapped {
                onKey?(mapped)
                handled = true
            }
        }
        if !handled { super.pressesBegan(presses, with: event) }
    }
}
