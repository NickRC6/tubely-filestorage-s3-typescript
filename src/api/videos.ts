import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import { getBearerToken, validateJWT } from "../auth";
import { stringWidth, type BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { randomBytes } from "crypto";

function classifyRatio(ratio: number): string {
  if (Math.abs(ratio - 1.78) < 0.05) return "landscape";
  if (Math.abs(ratio - 0.56) < 0.05) return "portrait";
  return "other";
  }

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30;

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading video", videoId, "by user", userID);

  const video = getVideo(cfg.db, videoId);

  if (!video) {
    throw new NotFoundError("Video not found!");
  }

  if (userID !== video.userID) {
    throw new UserForbiddenError("This video does not belong to this account!");
  }

  const formData = await req.formData();
  const file = formData.get("video");

  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File size exceeds maximum upload size");
  }

  if (file.type !== "video/mp4") {
    throw new BadRequestError("Invalid video format, only .mp4 is allowed");
  }

  const extension = ".mp4"
  const randomNameGen = randomBytes(32).toString("hex");
  const filename = `${randomNameGen}${extension}` 
  const tempPath = `/tmp/${filename}`;

  let processedVideo: string | undefined;
  
  try {
    await Bun.write(tempPath, file);
    processedVideo = await processVideoForFastStart(tempPath); 

    const aspectRatio = await getVideoAspectRatio(tempPath);

    const s3File = cfg.s3Client.file(`${aspectRatio}/${filename}`);
    await s3File.write(Bun.file(processedVideo), { type: file.type });

    //const newURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${aspectRatio}/${filename}`
    video.videoURL = `${aspectRatio}/${filename}`;
    
    updateVideo(cfg.db, video)
    const signedVideo = await dbVideoToSignedVideo(cfg, video)
    return respondWithJSON(200, signedVideo);
  } finally {
    await Bun.file(tempPath).delete();
    if (processedVideo) {
      await Bun.file(processedVideo).delete();
    }
  }
}


export async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn([
  "ffprobe",
  "-v", "error",
  "-select_streams", "v:0",
  "-show_entries", "stream=width,height",
  "-of", "json",
  filePath
], {
  stderr: "pipe",
  stdout: "pipe",
})

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Error: ${stderrText}`);
  }

  const data = JSON.parse(stdoutText)

  const width = data.streams[0].width;
  const height = data.streams[0].height;

  const ratio = width / height;

  return classifyRatio(ratio);
}

export async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = inputFilePath + ".processed";

  const proc = Bun.spawn([
    "ffmpeg",
    "-i", inputFilePath,
    "-movflags", "faststart",
    "-map_metadata", "0",
    "-codec", "copy", "-f", "mp4", outputFilePath
  ], {
    stderr: "pipe",
    stdout: "pipe",
  })

  const stderrText = await new Response(proc.stderr).text();

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Error: ${stderrText}`);
  }

  return outputFilePath;
}

export async function generatePresignedURL(cfg: ApiConfig, key: string, expireTime: number) {
  const presignedURL = cfg.s3Client.presign(key, { expiresIn: expireTime });

  return presignedURL;
}

export async function dbVideoToSignedVideo(cfg: ApiConfig, video: Video): Promise<Video> {
  if (!video.videoURL) {
    return video;
  }

  video.videoURL = await generatePresignedURL(cfg, video.videoURL, 900);
  return video;
}