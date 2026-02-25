import axios from "axios";
import { env } from "../config/env.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface BrandNumberParams {
  user_id: number;
  token: string;
}

interface GetJWTParams {
  token: string;
  email: string;
}

interface AssignAgentParams {
  user_id: number;
  token: string;
  email: string;
  mobile: string;
  value: string;
  type?: string;
}

interface AddLabelParams {
  user_id: number;
  token: string;
  mobile: string;
  value: string;
}

interface CpaasResult {
  success: boolean;
  message: string;
}

// ── getBrandNumber ────────────────────────────────────────────────────────────

export async function getBrandNumber({ user_id, token }: BrandNumberParams): Promise<string> {
  try {
    const { data } = await axios.post(
      `${env.AUTH_SERVER_URL}/wp_profile.php`,
      { method: "retrieve", user_id, token },
      { headers: { Origin: "http://localhost:3001" } }
    );

    if (!data.success) {
      throw new Error(`getBrandNumber failed: ${data.message ?? "unknown error"}`);
    }

    const brand = data.data?.[0]?.brand_number;
    if (!brand) {
      throw new Error("getBrandNumber: brand_number not found in response");
    }

    return brand as string;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      throw new Error(`getBrandNumber request failed: ${err.message}`);
    }
    throw err;
  }
}

// ── getJWT ────────────────────────────────────────────────────────────────────

export async function getJWT({ token, email }: GetJWTParams): Promise<string> {
  try {
    const { data } = await axios.post(`${env.TOOL_URL1}/generate_token`, {
      method: "user_token",
      email,
      token,
    });

    if (!data.success) {
      throw new Error(`getJWT failed: ${data.message ?? "unknown error"}`);
    }

    const jwt = data.data?.token;
    if (!jwt) {
      throw new Error("getJWT: token not found in response");
    }

    return jwt as string;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      throw new Error(`getJWT request failed: ${err.message}`);
    }
    throw err;
  }
}

// ── assignAgent ───────────────────────────────────────────────────────────────

export async function assignAgent({
  user_id,
  token,
  email,
  mobile,
  value,
  type = "agent",
}: AssignAgentParams): Promise<CpaasResult> {
  try {
    const [brand, jwt] = await Promise.all([
      getBrandNumber({ user_id, token }),
      getJWT({ token, email }),
    ]);

    const { data } = await axios.post(
      `${env.TOOL_URL1}/agent/chat_setting`,
      {
        brand,
        method: "chat_transfer",
        transfer_type: type,
        transfer_to: Number(value),
        chat_list: [mobile],
      },
      { headers: { Authorization: `Bearer ${jwt}` } }
    );

    return {
      success: data.success ?? false,
      message: data.message ?? "assignAgent completed",
    };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      throw new Error(`assignAgent request failed: ${err.message}`);
    }
    throw err;
  }
}

// ── addLabel ──────────────────────────────────────────────────────────────────

export async function addLabel({
  user_id,
  token,
  mobile,
  value,
}: AddLabelParams): Promise<CpaasResult> {
  try {
    const { data } = await axios.post(`${env.TOOL_URL2}/contact_list`, {
      user_id: Number(user_id),
      token,
      method: "add",
      channel: "whatsapp",
      list_id: Number(value),
      mobile,
    });

    return {
      success: data.success ?? false,
      message: data.message ?? "addLabel completed",
    };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      throw new Error(`addLabel request failed: ${err.message}`);
    }
    throw err;
  }
}
