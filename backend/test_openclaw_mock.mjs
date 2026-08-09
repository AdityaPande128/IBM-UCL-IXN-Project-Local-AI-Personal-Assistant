import { OpenAI } from 'openai';

const openai = new OpenAI({
  baseURL: 'http://127.0.0.1:8787/v1',
  apiKey: 'fake'
});

async function main() {
  console.log("Sending request to Responses API...");
  const stream = await openai.responses.create({
    model: 'granite-4.1-8b-4bit',
    input: [{ role: 'user', content: 'Search for the weather.' }],
    stream: true,
    tools: [{"type": "function", "function": {"name": "web_search", "description": "Search web", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}}}}]
  });

  for await (const chunk of stream) {
    console.log(JSON.stringify(chunk));
  }
}

main().catch(console.error);
