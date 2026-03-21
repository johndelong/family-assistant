import { z } from "zod";
import type { Tool } from "../../core/tools.js";

const braveFreshnessValues = ["pd", "pw", "pm", "py"] as const;

const webSearchSchema = z.object({
  query: z.string().min(1),
  count: z.number().int().min(1).max(10).optional(),
  country: z.string().min(2).max(2).optional(),
  language: z.string().min(2).max(10).optional(),
  ui_lang: z.string().min(2).max(10).optional(),
  freshness: z.enum(braveFreshnessValues).optional(),
  date_after: z.string().optional(),
  date_before: z.string().optional()
});

type WebSearchInput = z.infer<typeof webSearchSchema>;

interface WebSearchResult {
  query: string;
  results: Array<{
    title: string;
    url: string;
    description?: string;
    age?: string;
    language?: string;
  }>;
}

const webSearchJsonSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query to run on the public web"
    },
    count: {
      type: "number",
      description: "Number of results to return, from 1 to 10"
    },
    country: {
      type: "string",
      description: "Optional two-letter country code to localize results, for example US"
    },
    language: {
      type: "string",
      description: "Optional language code for result language, for example en"
    },
    ui_lang: {
      type: "string",
      description: "Optional UI language code, for example en-US"
    },
    freshness: {
      type: "string",
      enum: [...braveFreshnessValues],
      description: "Optional freshness window: pd day, pw week, pm month, py year"
    },
    date_after: {
      type: "string",
      description: "Optional lower date bound in YYYY-MM-DD format"
    },
    date_before: {
      type: "string",
      description: "Optional upper date bound in YYYY-MM-DD format"
    }
  },
  required: ["query"],
  additionalProperties: false
} satisfies Record<string, unknown>;

interface BraveSearchApiResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      age?: string;
      language?: string;
    }>;
  };
}

type BraveWebResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  language?: string;
};

export function createWebSearchTool(braveApiKey: string): Tool<WebSearchInput, WebSearchResult> {
  return {
    id: "web.search",
    description: "Search the public web for current information, recent developments, news, or external facts when conversation context is not enough",
    inputSchema: webSearchSchema,
    inputJsonSchema: webSearchJsonSchema,
    requiredCapabilities: [],
    exposure: "conversation",
    approvalPolicy: "never",
    targetScope: "self",
    async execute(input): Promise<WebSearchResult> {
      const params = new URLSearchParams({
        q: input.query,
        count: String(input.count ?? 5)
      });

      if (input.country) {
        params.set("country", input.country);
      }

      if (input.language) {
        params.set("search_lang", input.language);
      }

      if (input.ui_lang) {
        params.set("ui_lang", input.ui_lang);
      }

      if (input.freshness) {
        params.set("freshness", input.freshness);
      }

      if (input.date_after) {
        params.set("date_after", input.date_after);
      }

      if (input.date_before) {
        params.set("date_before", input.date_before);
      }

      const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": braveApiKey
        }
      });

      if (!response.ok) {
        const errorText = await safeReadText(response);
        throw new Error(`Brave Search request failed (${response.status}): ${errorText || response.statusText}`);
      }

      const payload = await response.json() as BraveSearchApiResponse;
      const results = (payload.web?.results ?? [])
        .filter((result): result is BraveWebResult & { title: string; url: string } =>
          typeof result?.title === "string" && typeof result?.url === "string")
        .map((result) => ({
          title: result.title,
          url: result.url,
          ...(result.description ? { description: result.description } : {}),
          ...(result.age ? { age: result.age } : {}),
          ...(result.language ? { language: result.language } : {})
        }));

      return {
        query: input.query,
        results
      };
    }
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
