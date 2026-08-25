import { describe, it, expect } from "vitest";
const LOG: string[] = [];
const log = (m: string) => LOG.push(m);

function shiftWeeks(weekStart: string, weeks: number): string {
  return new Date(new Date(`${weekStart}T00:00:00.000Z`).getTime() + weeks * 7 * 86_400_000)
    .toISOString().slice(0, 10);
}
/** fastest of N timed blocks, each running body `reps` times */
function perRun(body: () => void, reps: number, rounds = 6): number {
  let best = Infinity;
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) body();
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  return best;
}

describe("cpu", () => {
  it("aggregate shiftWeeks and ingest JSON.parse", async () => {
    // ---- shiftWeeks, as computeDeltas calls it ----
    const REPS = 7208;
    const total = perRun(() => { shiftWeeks("2026-08-17", -12); }, REPS);
    log(`shiftWeeks x${REPS} (one aggregate step) = ${total.toFixed(2)} ms  -> ${(total/REPS*1000).toFixed(2)} us/call`);
    // memoised alternative
    const table = new Map<number, string>();
    for (let i = 0; i >= -24; i--) table.set(i, shiftWeeks("2026-08-17", i));
    const memo = perRun(() => { table.get(-12); }, REPS);
    log(`memoised lookup x${REPS}          = ${memo.toFixed(2)} ms`);

    // ---- ingest: Response.json on a listing page, with and without `config` ----
    const mkRecord = (i: number, withConfig: boolean) => {
      const r: Record<string, unknown> = {
        id: `author${i}/model-name-${i}`, author: `author${i}`,
        createdAt: "2026-08-17T00:00:00.000Z", lastModified: "2026-08-18T00:00:00.000Z",
        downloads: i, downloadsAllTime: i * 10, likes: i % 50,
        tags: ["transformers","llama","text-generation","license:apache-2.0","base_model:meta-llama/Llama-3-8B","en","safetensors"],
        pipeline_tag: "text-generation", library_name: "transformers",
        cardData: { license: "apache-2.0", base_model: "meta-llama/Llama-3-8B", tags: ["a","b"], language: ["en"] },
      };
      if (withConfig) {
        r.config = {
          model_type: "llama", architectures: ["LlamaForCausalLM"],
          // the bulk of a real config: tokenizer + quantization blocks
          // sized to the repo's own recorded mean of 4,507 B per config
          tokenizer_config: { add_bos_token: true, model_max_length: 131072,
            chat_template: "{% for message in messages %}{{ message.content }}{% endfor %}".repeat(6),
            added_tokens_decoder: Object.fromEntries(Array.from({length: 12}, (_,k)=>[String(k),{content:`<|tok${k}|>`,lstrip:false,normalized:false,rstrip:false,single_word:false,special:true}])) },
          hidden_size: 4096, num_attention_heads: 32, num_hidden_layers: 32,
          rope_scaling: { type: "linear", factor: 8.0 }, torch_dtype: "bfloat16",
        };
      }
      return r;
    };
    for (const withConfig of [true, false]) {
      const page = Array.from({ length: 400 }, (_, i) => mkRecord(i, withConfig));
      const body = JSON.stringify(page);
      const bytes = new TextEncoder().encode(body).length;
      const ms = perRun(() => { JSON.parse(body); }, 8) / 8;
      log(`400-record page, config=${withConfig ? "YES" : "NO "}: ${(bytes/1024).toFixed(0)} KB (${Math.round(bytes/400)} B/rec), JSON.parse = ${ms.toFixed(2)} ms`);
    }
    expect(LOG.join("\n")).toBe("SHOW");
  });
});
