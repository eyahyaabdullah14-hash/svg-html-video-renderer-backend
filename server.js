const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const videosDir = path.join(__dirname, "videos");
const rendersDir = path.join(__dirname, "renders");

fs.mkdirSync(videosDir, { recursive: true });
fs.mkdirSync(rendersDir, { recursive: true });

app.use("/videos", express.static(videosDir));

const jobs = new Map();

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "SVG HTML Video Renderer"
  });
});

// Create render job
app.post("/api/render", (req, res) => {
  const jobId = uuidv4();

  jobs.set(jobId, {
    status: "queued",
    progress: 0,
    videoUrl: null,
    error: null
  });

  res.json({ jobId });

  renderVideo(jobId, req.body).catch((error) => {
    console.error(error);

    jobs.set(jobId, {
      status: "failed",
      progress: 0,
      videoUrl: null,
      error: error.message
    });
  });
});

// Get render status
app.get("/api/render/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      error: "Render job not found"
    });
  }

  res.json(job);
});

async function renderVideo(jobId, options = {}) {
  const html = String(options.html || "");
  const css = String(options.css || "");
  const javascript = String(options.javascript || "");

  const width = Math.min(
    Math.max(Number(options.width) || 1920, 100),
    3840
  );

  const height = Math.min(
    Math.max(Number(options.height) || 1080, 100),
    2160
  );

  const fps = Math.min(
    Math.max(Number(options.fps) || 30, 1),
    60
  );

  const duration = Math.min(
    Math.max(Number(options.duration) || 5, 0.1),
    60
  );

  const format =
    options.format === "webm" ? "webm" : "mp4";

  const transparent = Boolean(options.transparent);

  const background =
    transparent ? "transparent" : options.background || "#000000";

  const totalFrames = Math.ceil(fps * duration);

  const jobDir = path.join(rendersDir, jobId);
  const framesDir = path.join(jobDir, "frames");

  fs.mkdirSync(framesDir, { recursive: true });

  jobs.set(jobId, {
    status: "rendering",
    progress: 1,
    videoUrl: null,
    error: null
  });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage({
      viewport: {
        width,
        height
      }
    });

    const document = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">

<style>
html,
body {
  margin: 0;
  padding: 0;
  width: ${width}px;
  height: ${height}px;
  overflow: hidden;
  background: ${background};
}

${css}
</style>
</head>

<body>

${html}

<script>
${javascript}
<\/script>

</body>
</html>
`;

    await page.setContent(document, {
      waitUntil: "load"
    });

    // Pause Web Animations / CSS animations so we can seek them
    await page.evaluate(() => {
      document.getAnimations().forEach((animation) => {
        animation.pause();
      });
    });

    for (let frame = 0; frame < totalFrames; frame++) {
      const timeMs = (frame / fps) * 1000;

      await page.evaluate((time) => {
        document.getAnimations().forEach((animation) => {
          animation.pause();
          animation.currentTime = time;
        });
      }, timeMs);

      const filename =
        `frame-${String(frame).padStart(6, "0")}.png`;

      await page.screenshot({
        path: path.join(framesDir, filename),
        omitBackground: transparent
      });

      const progress =
        Math.max(
          1,
          Math.round(((frame + 1) / totalFrames) * 85)
        );

      jobs.set(jobId, {
        status: "rendering",
        progress,
        videoUrl: null,
        error: null
      });
    }
  } finally {
    await browser.close();
  }

  jobs.set(jobId, {
    status: "encoding",
    progress: 90,
    videoUrl: null,
    error: null
  });

  const outputFilename = `${jobId}.${format}`;
  const outputPath = path.join(videosDir, outputFilename);

  await encodeVideo({
    framesDir,
    outputPath,
    fps,
    format,
    transparent
  });

  jobs.set(jobId, {
    status: "completed",
    progress: 100,
    videoUrl: `/videos/${outputFilename}`,
    error: null
  });

  // Delete temporary PNG frames
  fs.rm(jobDir, {
    recursive: true,
    force: true
  }, () => {});
}

function encodeVideo({
  framesDir,
  outputPath,
  fps,
  format,
  transparent
}) {
  return new Promise((resolve, reject) => {
    const inputPattern =
      path.join(framesDir, "frame-%06d.png");

    let args;

    if (format === "webm") {
      args = [
        "-y",
        "-framerate",
        String(fps),
        "-i",
        inputPattern,
        "-c:v",
        "libvpx-vp9",
        "-crf",
        "20",
        "-b:v",
        "0"
      ];

      if (transparent) {
        args.push("-pix_fmt", "yuva420p");
      } else {
        args.push("-pix_fmt", "yuv420p");
      }

      args.push(outputPath);
    } else {
      args = [
        "-y",
        "-framerate",
        String(fps),
        "-i",
        inputPattern,
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        outputPath
      ];
    }

    const ffmpeg = spawn("ffmpeg", args);

    let errorOutput = "";

    ffmpeg.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    ffmpeg.on("error", (error) => {
      reject(
        new Error(`FFmpeg failed to start: ${error.message}`)
      );
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `FFmpeg exited with code ${code}: ${errorOutput.slice(-2000)}`
          )
        );
      }
    });
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Video renderer running on port ${PORT}`);
});
