/* Vercel Node.js entrypoint — serves as fallback only.
   Static files (public/) and API routes (api/) are handled by Vercel automatically. */
export default function handler(req, res) {
  res.status(404).send("Not found");
}
