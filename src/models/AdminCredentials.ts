import mongoose, { Schema, Document } from "mongoose";

export interface IAdminCredentials extends Document {
  adminId: string;
  user_id: number;
  token: string;
  email: string;
  createdAt: Date;
}

const AdminCredentialsSchema = new Schema<IAdminCredentials>({
  adminId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  user_id: {
    type: Number,
    required: true,
  },
  token: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const AdminCredentials = mongoose.model<IAdminCredentials>(
  "AdminCredentials",
  AdminCredentialsSchema
);

export default AdminCredentials;
