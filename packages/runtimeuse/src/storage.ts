import fs from "fs";
import { defaultLogger, type Logger } from "./logger.js";

export async function uploadFile(
  filePath: string,
  presignedUrl: string,
  contentType: string,
  logger: Logger = defaultLogger,
): Promise<boolean> {
  try {
    const content = fs.readFileSync(filePath);

    const response = await fetch(presignedUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
      },
      body: content,
    });

    if (response.ok) {
      logger.log(
        `Upload succeeded for ${filePath} with status ${response.status} ${response.statusText}`,
      );
    } else {
      logger.error(
        `Upload failed for ${filePath} with status ${response.status} ${response.statusText}`,
      );
    }

    return response.ok;
  } catch (error) {
    logger.error("Upload error:", error);
    return false;
  }
}
