# Hello Apricot

A tiny Android app for checking that your Apricot setup works. It has:

- a button that counts taps (tests touch)
- a text field that echoes what you type (tests the keyboard)
- `HelloApricot` log lines (tests the Logs tab)

`hello-apricot.apk` is prebuilt and signed with the standard Android debug key, so you can drop it straight into Apricot.

## Rebuild it

It builds with the raw Android build tools and needs no Gradle or Android Studio project:

```bash
~/Library/Android/sdk/cmdline-tools/latest/bin/sdkmanager "build-tools;35.0.0" "platforms;android-35"
```

```bash
./build.sh
```

`build.sh` runs `aapt2` (resources), `javac` + `d8` (code), then `zipalign` + `apksigner`. It's a handy reference
for what a build tool does under the hood.
