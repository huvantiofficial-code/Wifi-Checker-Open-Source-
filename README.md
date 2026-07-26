# Wifi Checker - Open Source Speed Tester

A high-quality, lightweight, pure client-side Internet Speed Test tool designed with Google's Material Design guidelines.

This speed tester is specifically built to measure **real international internet speed** by bypassing local caching networks (like BDIX loops), routing measurements through global high-performance CDN edges (Cloudflare, jsDelivr Fastly, and Google Hosted Libraries).

## 🚀 Key Features

*   **Real Server Testing (No BDIX):** Avoids false high-speed readouts caused by ISP local cache loops. It tests your connection against global edge servers, showing what you actually get when accessing international content (Netflix, YouTube, GitHub, AWS, etc.).
*   **Highly Accurate Measurements:**
    *   **Latency & Jitter:** Performs multiple sequential latency checks and calculates physical ping along with true Jitter variation in milliseconds.
    *   **Download Speed:** Uses multi-threaded streaming fetches with custom cache-busting parameters to fully saturate your download capacity.
    *   **Upload Speed:** Uses parallel `XMLHttpRequest` POST requests to global REST endpoints with real-time uploading progress tracking.
*   **Google Search UI Style:** Fully modeled after the clean, minimalist Google Speed Test card widget. Includes a circular SVG gauge speed indicator and live pulsing indicators.
*   **Modern Work Sans Typography:** Completely loaded with Google's open-source `Work Sans` font family for crisp legibility.
*   **No Backend Needed:** Works entirely in the user's browser with no backend dependencies, meaning zero hosting overhead and absolute client-side privacy.

## 🛠️ How it Works

1.  **Latency Phase (Ping & Jitter):**
    Probes standard edge points sequentially. The true ping is identified as the minimum round-trip time (RTT), and jitter is determined using the standard network formula:
    $$\text{Jitter} = \frac{\sum_{i=1}^{n-1} |RTT_{i+1} - RTT_i|}{n-1}$$
2.  **Download Phase:**
    Spawns concurrent chunk-streaming workers that pull data continuously from high-speed, CORS-configured libraries on global CDNs. Samples are collected every 100ms using a rolling average window to update the needle gauge smoothly.
3.  **Upload Phase:**
    Generates a secure cryptographically random block of bytes (preventing intermediate compression optimizations) and POSTs them across concurrent connections. Listens to direct socket upload events to evaluate transmission speeds accurately.

## 📦 Getting Started

Since this is a fully standalone web application, you can run it instantly:

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/huvantiofficial-code/Wifi-Checker-Open-Source-.git
    ```
2.  **Open the application:**
    Simply double-click the `index.html` file in your browser, or host it on free services like **GitHub Pages**, **Vercel**, or **Netlify**.

## 📄 License

This project is licensed under the MIT License. Contributions and forks are highly welcome!
