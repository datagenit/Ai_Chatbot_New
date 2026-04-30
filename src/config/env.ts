import "dotenv/config";

function getEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvOptional(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

export const env = {
  NODE_ENV: getEnvOptional("NODE_ENV", "development"),
  PORT: parseInt(getEnvOptional("PORT", "3000"), 10),
  GOOGLE_API_KEY: getEnv("GOOGLE_API_KEY"),
  GEMINI_API_KEY: getEnv("GEMINI_API_KEY"),
  MONGODB_URI: getEnv("MONGODB_URI"),
  JWT_SECRET: getEnv("JWT_SECRET"),
  TOOL_URL1: getEnv("TOOL_URL1"),
  TOOL_URL2: getEnv("TOOL_URL2"),
  TOOL_URL3: getEnv("TOOL_URL3"),
  AUTH_SERVER_URL: getEnv("AUTH_SERVER_URL"),
  PINECONE_API_KEY: getEnv("PINECONE_API_KEY"),       
  PINECONE_INDEX_NAME: getEnv("PINECONE_INDEX_NAME"),
  INTERNAL_SERVER_IP: process.env["INTERNAL_SERVER_IP"]
} as const;

export const PINECONE_NS_PREFIX = process.env.PINECONE_NS_PREFIX ?? "";

export type Env = typeof env;
