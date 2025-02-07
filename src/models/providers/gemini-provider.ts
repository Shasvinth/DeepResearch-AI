import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

// Initialize the Google AI client
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);

// Configure safety settings - using permissive settings since this is a research tool
const safetySettings = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

// Create a model instance with the Pro version for better performance
const model = genAI.getGenerativeModel({ 
  model: "gemini-pro",
  safetySettings,
});

// Helper function to extract JSON from text
function extractJSON(text: string): string | null {
  // Try to find JSON between triple backticks first
  const codeBlockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1];
  }

  // Try to find the outermost JSON object
  const startIndex = text.indexOf('{');
  const endIndex = text.lastIndexOf('}');
  
  if (startIndex === -1 || endIndex === -1) {
    return null;
  }

  // Count braces to ensure we get a complete JSON object
  let braceCount = 0;
  let jsonStartIndex = -1;
  
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (braceCount === 0) {
        jsonStartIndex = i;
      }
      braceCount++;
    } else if (text[i] === '}') {
      braceCount--;
      if (braceCount === 0 && jsonStartIndex !== -1) {
        return text.substring(jsonStartIndex, i + 1);
      }
    }
  }

  // If we couldn't find a complete JSON object, return the simple extraction
  return text.substring(startIndex, endIndex + 1);
}

// Helper function to generate structured output
export async function generateWithGemini<T>({ 
  system,
  prompt,
  schema
}: { 
  system: string;
  prompt: string;
  schema: any;
}) {
  try {
    console.log('\n🤖 Generating with Gemini...');
    console.log('System prompt:', system);
    console.log('User prompt:', prompt);

    // Create a structured prompt that asks for JSON output
    const structuredPrompt = `${system}

IMPORTANT: Your response must be a valid JSON object matching this schema:
${JSON.stringify(schema, null, 2)}

You can optionally wrap the JSON in triple backticks for clarity.

Query: ${prompt}

Remember to ONLY return a valid JSON object.`;
    
    const result = await model.generateContent(structuredPrompt);
    const response = await result.response;
    const text = response.text();
    
    console.log('\nRaw Gemini response:', text);

    // Try to parse the response as JSON
    try {
      const jsonStr = extractJSON(text);
      if (!jsonStr) {
        throw new Error('No JSON object found in response');
      }

      console.log('\nExtracted JSON:', jsonStr);
      
      const parsed = JSON.parse(jsonStr);
      console.log('\nParsed response:', parsed);
      
      return {
        object: parsed
      };
    } catch (e) {
      console.error('\nFailed to parse JSON response:', e);
      
      // Try to generate again with a more explicit prompt
      console.log('\nRetrying with explicit JSON prompt...');
      
      const retryPrompt = `${structuredPrompt}\n\nPREVIOUS ATTEMPT FAILED. You MUST return ONLY a valid JSON object matching the schema. No other text or formatting.`;
      
      const retryResult = await model.generateContent(retryPrompt);
      const retryResponse = await retryResult.response;
      const retryText = retryResponse.text();
      
      const jsonStr = extractJSON(retryText);
      if (!jsonStr) {
        throw new Error('Failed to get JSON response after retry');
      }
      
      const parsed = JSON.parse(jsonStr);
      console.log('\nParsed retry response:', parsed);
      
      return {
        object: parsed
      };
    }
  } catch (e) {
    console.error('\nError generating with Gemini:', e);
    
    // Create a basic fallback response based on the schema
    const fallbackResponse = createFallbackResponse(prompt, schema);
    console.log('\nUsing fallback response:', fallbackResponse);
    
    return {
      object: fallbackResponse
    };
  }
}

// Helper function to create a fallback response when JSON parsing fails
function createFallbackResponse(text: string, schema: any): any {
  const schemaProperties = schema.properties || {};
  const response: any = {};

  // For each property in the schema, try to extract relevant information
  for (const [key, value] of Object.entries(schemaProperties)) {
    if (value.type === 'array') {
      // If it's an array type, split the text into reasonable chunks
      response[key] = text.split(/[.!?]\s+/)
        .filter(s => s.length > 10)
        .map(s => s.trim())
        .slice(0, 5); // Limit to 5 items
    } else if (value.type === 'string') {
      // If it's a string type, use a cleaned version of the text
      response[key] = text.slice(0, 500).trim(); // Limit to 500 chars
    } else if (value.type === 'object' && value.properties) {
      // Handle nested objects
      response[key] = createFallbackResponse(text, value);
    }
  }

  return response;
}

// Export the main function to match the OpenAI interface
export function createGeminiClient() {
  return async function geminiModel(
    _model: string,
    options: { structuredOutputs?: boolean; reasoningEffort?: string }
  ) {
    return generateWithGemini;
  };
} 