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

    logger.log(`File ${filePath} uploaded with status: ${response.status}`);

    return response.status === 200;
  } catch (error) {
    logger.error("Upload error:", error);
    return false;
  }
}
