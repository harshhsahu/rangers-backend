import jwt from "jsonwebtoken";

/**
 * Embed-style JWT with org_id, folder_id, and user_id (current user's org id).
 * Signed with ACCESS_KEY using HS256.
 */
export function signInternalJwt({ userOrgId }) {
  const accessKey = process.env.ACCESS_KEY;
  if (!accessKey) throw new Error("ACCESS_KEY is not configured");
  if (!process.env.ORG_ID) throw new Error("ORG_ID is not configured");
  if (!process.env.FOLDER_ID) throw new Error("FOLDER_ID is not configured");

  const payload = {
    org_id: String(process.env.ORG_ID),
    folder_id: String(process.env.FOLDER_ID),
    user_id: String(userOrgId || ""),
  };

  return jwt.sign(payload, accessKey, { algorithm: "HS256" });
}
