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

// ── fetchTicketKeywords ───────────────────────────────────────────────────────

export async function fetchTicketKeywords(
  user_id: number,
  token: string
): Promise<string[]> {
  try {
    const { data } = await axios.post(
      `${env.TOOL_URL1}/v1/agent_ticket`,
      { user_id, method: "fetch_keywords", token, user_type: "admin" }
    );
    return (data.data ?? []).map((k: any) => k.keywords.keywords);
  } catch {
    return [];
  }
}

// ── createTicketAPI ───────────────────────────────────────────────────────────

export async function createTicketAPI(params: {
  user_id: number;
  token: string;
  ticket_name: string;
  ticket_description: string;
  priority: "low" | "medium" | "high";
  keywords: string;
  remark: string;
  customer_number: string;
  customer_name?: string;
  created_name?: string;
}): Promise<{ success: boolean; message: string }> {
  try {
    const { data } = await axios.post(
      `${env.TOOL_URL1}/v1/agent_ticket`,
      {
        user_id: params.user_id,
        user_type: "admin",
        token: params.token,
        ticket_name: params.ticket_name,
        ticket_description: params.ticket_description,
        remark: params.remark,
        priority: params.priority,
        method: "createTicket",
        keywords: params.keywords,
        customer_number: params.customer_number,
        customer_name: params.customer_name || "Customer",
        created_name: params.created_name || "AIBOT",
        customer_email: ".",
        currentDate: new Date().toISOString().split("T")[0],
        assignee_name: "admin",
        agent_id: params.user_id,
        Assignee: { auto_assign: 1, assign_to: "" },
        assigned_to_id: "",
      }
    );
    return { success: true, message: data.message ?? "Ticket created successfully" };
  } catch (err) {
    const msg = axios.isAxiosError(err)
      ? err.response?.data?.message ?? err.message
      : err instanceof Error
        ? err.message
        : "Unknown error";
    return { success: false, message: msg };
  }
}

// ── sendTemplate ─────────────────────────────────────────────────────────────

export async function sendTemplate(params: {
  user_id: number;
  token: string;
  mobile: string;
  wid: number;
  templateName: string;
  bodyParams: Record<string, string>;
  headerParams: Record<string, string>;
  mediaUrl: string;
  brandNumber?: string;
  createdByName?: string;
  createdById?: number;
}): Promise<void> {
  const { data } = await axios.post(`${env.TOOL_URL3}/bulk_campaign_whatsapp.php`, {
    method: "agent_broadcast_single",
    user_id: params.user_id,
    token: params.token,
    channel: "whatsapp",
    created_by: "AGENT",
    created_by_name: params.createdByName ?? "AI Agent",
    created_by_id: params.createdById ?? params.user_id,
    camp_name: "promotion",
    template_id: params.wid,
    media_url: params.mediaUrl,
    brand_number: params.brandNumber ?? "",
    total_count: 1,
    parameter: {
      body: { ...params.bodyParams },
      header: { ...params.headerParams },
    },
    data: [{ mobile: params.mobile }],
  });
  console.log({
    
      method: "agent_broadcast_single",
      user_id: params.user_id,
      token: params.token,
      channel: "whatsapp",
      created_by: "AGENT",
      created_by_name: params.createdByName ?? "AI Agent",
      created_by_id: params.createdById ?? params.user_id,
      camp_name: "promotion",
      template_id: params.wid,
      media_url: params.mediaUrl,
      brand_number: params.brandNumber ?? "",
      total_count: 1,
      parameter: {
        body: { ...params.bodyParams },
        header: { ...params.headerParams },
      },
      data: [{ mobile: params.mobile }],
  });
  if (!data.success) throw new Error(data.message ?? "sendTemplate failed");
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
