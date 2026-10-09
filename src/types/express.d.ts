declare global {
  namespace Express {
    interface Request {
      /** GTWY session token from the Authorization header or same-origin cookie (see middlewares/sessionToken). */
      sessionToken?: string | null;
    }
  }
}

export {};
