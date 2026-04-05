/**
 * Netlify Function (plano gratuito): recebe um resumo em texto e chama a API Groq (tier gratuito).
 *
 * Configure no painel Netlify → Site settings → Environment variables:
 *   GROQ_API_KEY   = chave em https://console.groq.com/keys
 * Opcional (recomendado):
 *   FLUXO_INSIGHTS_SECRET = uma senha longa; o app envia o mesmo valor no cabeçalho X-Fluxo-Secret.
 *
 * URL após deploy: https://SEU-SITE.netlify.app/.netlify/functions/fluxo-insights
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Fluxo-Secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Use POST" }) };
  }

  const expectedSecret = process.env.FLUXO_INSIGHTS_SECRET;
  const sentSecret =
    event.headers["x-fluxo-secret"] || event.headers["X-Fluxo-Secret"] || "";
  if (expectedSecret && sentSecret !== expectedSecret) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Secret inválido" }) };
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({ error: "Servidor sem GROQ_API_KEY configurada" }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "JSON inválido" }) };
  }

  const summary = body.summary;
  if (!summary || typeof summary !== "string") {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Campo summary ausente" }) };
  }

  if (summary.length > 120000) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: "Resumo muito grande" }) };
  }

  const system = `Você é um planejador financeiro pessoal objetivo. Responda em português do Brasil.
Use markdown (títulos, listas) quando ajudar a leitura.
Regras: não invente números que não apareçam no contexto; se faltar dado, diga o que falta.
Inclua: (1) visão geral do padrão de caixa, (2) riscos ou alertas, (3) até 7 sugestões práticas e priorizadas para o próximo mês.`;

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + groqKey,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: summary },
      ],
      temperature: 0.35,
      max_tokens: 2000,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: data.error?.message || "Erro na API Groq",
      }),
    };
  }

  const text = data.choices?.[0]?.message?.content || "";
  return { statusCode: 200, headers, body: JSON.stringify({ text }) };
};
