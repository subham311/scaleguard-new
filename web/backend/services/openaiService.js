import OpenAI from 'openai';

let openaiClient = null;

function getOpenAIClient() {
  if (openaiClient) return openaiClient;
  
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("?? OPENAI_API_KEY environment variable is not defined. OpenAI service will operate in fallback mode.");
    return null;
  }
  
  try {
    openaiClient = new OpenAI({ apiKey });
    return openaiClient;
  } catch (error) {
    console.error("? Failed to initialize OpenAI client:", error);
    return null;
  }
}

/**
 * Uses OpenAI to evaluate the commercial quality of a product description.
 * Adheres to SOW Section 1.2, 1.3 & 7.1 fallback strategy.
 * 
 * @param {string} title - Product title
 * @param {string} description - Product description html or text
 * @returns {Promise<{score: number, isSupplierContent: boolean, isSpecDump: boolean, reason: string} | null>}
 */
export async function evaluateDescriptionQualityWithAI(title, description) {
  const client = getOpenAIClient();
  if (!client) {
    return null; // Fallback to rules/heuristics
  }

  const cleanDescription = (description || '').replace(/<[^>]*>?/gm, ' ').trim();
  if (!cleanDescription || cleanDescription.length < 5) {
    return {
      score: 0,
      isSupplierContent: false,
      isSpecDump: false,
      reason: "Description is empty or too short."
    };
  }

  try {
    console.log(`?? [OpenAI] Evaluating description quality for product: "${title}"`);
    
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini", // Cost-effective, fast, and highly accurate for categorization
      messages: [
        {
          role: "system",
          content: "You are an expert ecommerce copywriter and trust auditor. Analyze the provided product title and description. You must output valid JSON only."
        },
        {
          role: "user",
          content: `Analyze the description quality for the product.
Title: "${title}"
Description: "${cleanDescription}"

Grade the description on a scale of 0 to 100 based on:
- Persuasiveness and readability
- Clear customer benefits and differentiation
- Absence of supplier boilerplate, translation mistakes, or Temu/AliExpress shipping templates.

Check if it is a pure "Specification Dump" (primarily listing dimensions/materials with no benefits or sales copy).
Check if it contains "Supplier Content" (AliExpress templates, brand-new high-quality boilerplates, color deviation alerts).

Return a JSON object in this exact format:
{
  "score": number (0-100),
  "isSupplierContent": boolean,
  "isSpecDump": boolean,
  "reason": "brief string explaining key highlights or issues"
}`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 150
    });

    const result = JSON.parse(response.choices[0].message.content.trim());
    return {
      score: typeof result.score === 'number' ? Math.max(0, Math.min(100, result.score)) : 50,
      isSupplierContent: !!result.isSupplierContent,
      isSpecDump: !!result.isSpecDump,
      reason: result.reason || "Audited via AI."
    };
  } catch (error) {
    console.error("? OpenAI API call failed, falling back to heuristics:", error);
    return null;
  }
}
