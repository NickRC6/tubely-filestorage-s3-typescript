import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import { getBearerToken, validateJWT } from "../auth";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getVideo, updateVideo } from "../db/videos";
import { randomBytes } from "crypto";

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
  
  try {
    await Bun.write(tempPath, file);

    const s3File = cfg.s3Client.file(filename);
    await s3File.write(Bun.file(tempPath), { type: file.type });

    const newURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${filename}`
    video.videoURL = newURL;
    
    updateVideo(cfg.db, video)
    return respondWithJSON(200, video);
  } finally {
    await Bun.file(tempPath).delete();
  }
}
