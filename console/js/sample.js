// The one runnable sample worker. Both the first-paint view and CodeMirror show sample(lang),
// so swapping editors never changes the text. examples/worker/index.js === sample('zh') (tested).
const TEXT = {
  zh: { head: '和 Cloudflare Workers 一样的写法', json: 'GET /api/time 返回 JSON', post: 'POST 读取请求体', hello: '你好，这里是', got: '收到', bytes: '字节' },
  en: { head: 'Same shape as a Cloudflare Worker', json: 'GET /api/time returns JSON', post: 'POST reads the body', hello: 'Hello from', got: 'Got', bytes: 'bytes' },
};

export function sample(lang = 'zh') {
  const s = TEXT[lang] || TEXT.zh;
  return `// ${s.head}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ${s.json}
    if (url.pathname === "/api/time") {
      return Response.json({ time: new Date().toISOString(), from: env.GREETING ?? "funx" });
    }

    // ${s.post}
    if (request.method === "POST") {
      const text = await request.text();
      return new Response(\`${s.got} \${text.length} ${s.bytes}\\n\`);
    }

    return new Response(\`${s.hello} \${url.hostname}\\n\`, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
`;
}

export const isSample = (code) => Object.keys(TEXT).some((l) => sample(l) === code);
