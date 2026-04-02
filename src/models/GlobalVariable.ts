import mongoose, { Schema, Document } from "mongoose";

export interface IGlobalVariable extends Document {
  adminId:     string;
  key:         string;
  value:       string;
  description: string;
  createdAt:   Date;
  updatedAt:   Date;
}

const GlobalVariableSchema = new Schema<IGlobalVariable>({
  adminId:     { type: String, required: true, index: true },
  key:         { type: String, required: true, trim: true },
  value:       { type: String, required: true, default: "" },
  description: { type: String, default: "" },
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
});

// One key per admin — prevent duplicates
GlobalVariableSchema.index({ adminId: 1, key: 1 }, { unique: true });

// Keep updatedAt current on every save
GlobalVariableSchema.pre("save", async function () {
  this.updatedAt = new Date();
});

const GlobalVariable = mongoose.model<IGlobalVariable>(
  "GlobalVariable",
  GlobalVariableSchema
);

export default GlobalVariable;
