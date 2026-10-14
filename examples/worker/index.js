// 和 Cloudflare Workers 一样的写法
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // GET /api/time 返回 JSON
    if (url.pathname === "/api/time") {
      return Response.json({ time: new Date().toISOString(), from: env.GREETING ?? "funx" });
    }

    // POST 读取请求体
    if (request.method === "POST") {
      const text = await request.text();
      return new Response(`收到 ${text.length} 字节\n`);
    }

    return new Response(`你好，这里是 ${url.hostname}\n`, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
