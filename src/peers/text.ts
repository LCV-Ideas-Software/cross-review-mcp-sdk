export function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function textFromAnthropicContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function textFromOpenAIResponse(response: {
  output_text?: string;
  output?: unknown;
}): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  return compactJson(response.output ?? response);
}

export function userPrompt(reviewPrompt: string): string {
  return reviewPrompt.trim();
}
