import mongoose, { Document, Schema } from "mongoose";

export interface IUploadedFile extends Document {
  adminId: string;
  originalName: string;
  filePath: string;
  type: "pdf" | "text" | "url";
  chunks: number;
  vectorIds: string[];
  content: string;
  uploadedAt: Date;
}

const UploadedFileSchema = new Schema<IUploadedFile>({
  adminId: { type: String, required: true },
  originalName: { type: String, required: true },
  filePath: { type: String, required: true },
  type: { type: String, enum: ["pdf", "text", "url"], default: "pdf" },
  chunks: { type: Number, required: true },
  vectorIds: { type: [String], default: [] },
  content: { type: String, default: "" },
  uploadedAt: { type: Date, default: Date.now },
});

export default mongoose.model<IUploadedFile>("UploadedFile", UploadedFileSchema);
