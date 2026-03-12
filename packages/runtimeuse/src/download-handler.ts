import path from "path";
import fs from "fs";
import { execFileSync } from "child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { Logger } from "./logger.js";

class DownloadHandler {
  private readonly logger: Logger;
  constructor(logger: Logger) {
    this.logger = logger;
  }

  async download(downloadUrl: string, workingDir: string): Promise<void> {
    if (!fs.existsSync(workingDir)) {
      fs.mkdirSync(workingDir, { recursive: true });
    }
    const fileUrl = new URL(downloadUrl);
    const filename = decodeURIComponent(path.basename(fileUrl.pathname));
    const filepath = path.join(workingDir, filename);

    this.logger.log(`Downloading file ${filename} to ${filepath}`);

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(
        `Download failed: ${response.status} ${response.statusText}`,
      );
    }
    if (!response.body) {
      throw new Error("Download failed: no response body");
    }

    const fileStream = fs.createWriteStream(filepath);
    await pipeline(Readable.fromWeb(response.body as any), fileStream);

    if (path.extname(filepath) === ".zip") {
      this.logger.log(`Unzipping file ${filename}`);
      execFileSync("unzip", ["-o", filepath, "-d", workingDir]);
      fs.unlinkSync(filepath);
    }
  }
}

export default DownloadHandler;
