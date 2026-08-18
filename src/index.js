export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    return new Response("Hello, World!\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
