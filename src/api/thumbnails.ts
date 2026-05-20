import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";



export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const file = formData.get("thumbnail");
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }

  const MAX_UPLOAD_SIZE = 10485760;
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File size exceeds maximum upload size");
  }

  if (file.type != "image/jpeg" && file.type != "image/png") {
    throw new BadRequestError("Wrong filetype.");
  }

  const fileType = file.type;

  const imageData = await file.arrayBuffer()
  const imageBuffer = Buffer.from(imageData);
  const extension = fileType.split("/");
  const filename = `${videoId}.${extension[1]}` 
  const savingPath = path.join(cfg.assetsRoot, filename);
  Bun.write(savingPath, imageBuffer);
  const dataURL = `http://localhost:${cfg.port}/${savingPath}`;


  const video = getVideo(cfg.db, videoId);

  if (!video) {
    throw new NotFoundError("Video not found!");
  }

  if (userID !== video.userID) {
    throw new UserForbiddenError("This video does not belong to this account!");
  }

  video.thumbnailURL = dataURL;

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
