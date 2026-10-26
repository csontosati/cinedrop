# CineDrop

> **Native iOS studio for iPhone videographers & stock footage contributors.**  
> Automatically normalizes Variable Frame Rate (VFR) to strict Constant Frame Rate (CFR), enforces stock agency duration compliance, applies calibrated stock color profiles, and uploads directly to **BlackBox Global (`portal.blackbox.global`)** over Explicit FTPS.

---

## The Problem It Solves

Mobile filmmakers shooting stock footage on iPhone face frequent rejections from stock agencies (Shutterstock, Adobe Stock, Getty Images, Pond5 via BlackBox) due to mobile-specific video quirks:

1. **Variable Frame Rate (VFR) Rejections:** iPhones dynamically fluctuate recording frame rates to manage heat and light. Stock platforms strictly require **Constant Frame Rate (CFR)**. CineDrop automatically re-encodes source footage to broadcast-standard CFR (`23.976`, `24`, `25`, `29.97`, `30`, `50`, `59.94`, or `60` fps).
2. **Agency Duration Rules (5.0s – 59.0s):** BlackBox rejects clips under 5.0 seconds or over 59.0 seconds. CineDrop's live compliance guard continuously calculates final duration based on your **In/Out Trim points** and **Slow-Motion speed** (`1.0x`, `0.8x`, `0.5x`, `0.4x`, `0.25x`), preventing out-of-spec submissions.
3. **Log & HDR Color Normalization:** Automatically maps 10-bit Apple Log, HDR HLG, and HDR10 PQ footage into standard Rec.709 color space with calibrated exposure, contrast, warmth, and detail sharpening presets.
4. **1-Tap Mic Mute:** Strips audio tracks (`-an`) by default to prevent stock agency rejections due to ambient background noise.
5. **Direct FTPS Ingestion Queue:** Uploads directly to your `portal.blackbox.global` account over encrypted Explicit TLS (`FTPS`) without requiring you to transfer heavy footage to a desktop computer first.

---

## Quick Start: Run on iPhone (Zero Sideloading Required)

You can run CineDrop on your physical iPhone immediately using the free **Expo Go** client from the App Store:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/<your-username>/blackbox-editor.git
   cd blackbox-editor
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Launch the development studio:**
   * On Windows: Double-click [`start-studio.bat`](./start-studio.bat) (or run `npm run dev` in your terminal).
   * On macOS / Linux: Run `npm run dev`.
4. **Connect your iPhone:**
   * Open the **Expo Go** app on your iPhone.
   * Scan the QR code displayed in your terminal.
5. **Configure BlackBox Uploads:**
   * Tap **FTP Setup** (top right in the app).
   * Enter your BlackBox FTP username & password (found on `portal.blackbox.global` under *Account → FTP Info*).
   * Your computer's local processing bridge is automatically detected.

---

## Free Standalone iOS Build (GitHub Actions)

If you prefer a standalone `.ipa` installed directly on your iOS device without Expo Go, a GitHub Actions workflow is included that compiles an unsigned release build in the cloud for free:

1. Fork or push this repository to your GitHub account.
2. In your GitHub repo, navigate to **Actions** → select **Build Unsigned iOS IPA**.
3. Click **Run workflow**.
4. Once completed, download the `BB-Direct-Studio-iOS-IPA` artifact.
5. Install the `.ipa` onto your device using **SideStore**, **AltStore**, or **Sideloadly**.

---

## Architecture & Technology Stack

* **Frontend:** React Native 0.88, Expo SDK 58, TypeScript, `expo-video`, `expo-image-picker`.
* **Security & Storage:** Secure credential handling via `expo-secure-store` (iOS Keychain).
* **Companion Bridge:** Node.js, Express, `basic-ftp` (Explicit FTPS TLS), `multer`.
* **Media Engine:** Static FFmpeg 5.x & FFprobe pipeline implementing High-Profile H.264 (CRF 16 visually lossless, Lanczos scaling, and Rec.709 VUI tags).

---

## Verification Pipeline

Verify that the FFmpeg color normalization and CFR pipeline conforms to BlackBox Global requirements:

```bash
npm test
```

The test script generates a synthetic 1080p 60fps HDR HLG video stream, applies trim, speed ramp, and stock color grading, and inspects the output via `ffprobe` to assert CFR cadence, duration bounds, and Rec.709 metadata.

---

## License & Community Contributions

This project is licensed under the **PolyForm Noncommercial License 1.0.0** with author commercial reservations. See [`LICENSE.md`](./LICENSE.md) for full details.

* **Free for Personal & Community Use:** Anyone is welcome to view the code, clone, modify, build, and use this software for their personal workflows.
* **Non-Commercial:** Third parties may not package, sell, redistribute, or commercially monetize this software or any derivative works.
* **Author Reservation:** The original author retains all commercial rights, including the exclusive right to publish and distribute pre-compiled builds on marketplaces such as the Apple App Store.
* **Contributions:** Community contributions and pull requests are welcomed. By submitting contributions, you agree that your code may be incorporated into both the open repository and official releases under the terms set forth in [`LICENSE.md`](./LICENSE.md).
