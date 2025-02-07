import { GoogleGenerativeAI } from '@google/generative-ai';
import pLimit from 'p-limit';

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// Rate limit to 5 concurrent requests
const limit = pLimit(5);

// Helper function to delay execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to retry a function with exponential backoff
async function retry<T>(
  fn: () => Promise<T>,
  retries = 3,
  baseDelay = 1000,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (retries === 0) throw e;
    
    // If we hit rate limits, wait longer
    const isRateLimit = e.message?.includes('429') || e.message?.includes('quota');
    const waitTime = isRateLimit ? baseDelay * 2 : baseDelay;
    
    console.log(`Retrying after ${waitTime}ms...`);
    await delay(waitTime);
    
    return retry(fn, retries - 1, waitTime * 2);
  }
}

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

  return text.substring(startIndex, endIndex + 1);
}

export async function generateFeedback({
  query,
  numQuestions = 3,
}: {
  query: string;
  numQuestions?: number;
}) {
  try {
    console.log('\n📝 Generating feedback questions...');
    
    const prompt = `Given this research query: "${query}"

Generate ${numQuestions} insightful follow-up questions to better understand what specific aspects the user wants to research.
The questions should help clarify the scope, priorities, and specific areas of interest.

Format your response as a JSON object like this:
{
  "questions": [
    "What specific aspects of X are you most interested in?",
    "Are there particular Y that you want to focus on?",
    "How important is Z compared to other factors?"
  ]
}

IMPORTANT: Return ONLY the JSON object, no other text.`;

    // Use rate limiting and retries
    const result = await limit(() => 
      retry(async () => {
        const response = await model.generateContent(prompt);
        return response;
      })
    );
    
    const text = result.response.text();
    console.log('\nRaw response:', text);

    try {
      const jsonStr = extractJSON(text);
      if (!jsonStr) {
        throw new Error('No JSON found in response');
      }

      console.log('\nExtracted JSON:', jsonStr);
      
      const parsed = JSON.parse(jsonStr);
      console.log('\nParsed questions:', parsed.questions);
      
      // Ensure we have valid questions
      const validQuestions = parsed.questions
        .filter(q => typeof q === 'string' && q.trim().length > 0 && q.includes('?'))
        .map(q => q.trim())
        .slice(0, numQuestions);

      if (validQuestions.length === 0) {
        throw new Error('No valid questions found in response');
      }
      
      return validQuestions;
    } catch (e) {
      console.error('\nFailed to parse JSON response:', e);
      
      // Try to generate again with a more explicit prompt
      console.log('\nRetrying with explicit prompt...');
      
      const retryPrompt = `${prompt}\n\nPREVIOUS ATTEMPT FAILED. You MUST return ONLY a valid JSON object with an array of questions. No other text.`;
      
      const retryResult = await limit(() => 
        retry(async () => {
          const response = await model.generateContent(retryPrompt);
          return response;
        })
      );
      
      const retryText = retryResult.response.text();
      
      const jsonStr = extractJSON(retryText);
      if (!jsonStr) {
        throw new Error('Failed to get JSON response after retry');
      }
      
      const parsed = JSON.parse(jsonStr);
      const validQuestions = parsed.questions
        .filter(q => typeof q === 'string' && q.trim().length > 0 && q.includes('?'))
        .map(q => q.trim())
        .slice(0, numQuestions);

      if (validQuestions.length === 0) {
        throw new Error('No valid questions found in retry response');
      }
      
      return validQuestions;
    }
  } catch (e) {
    console.error('\nError generating feedback:', e);
    // Return default questions that are relevant to most research queries
    return [
      `What specific aspects of "${query}" are you most interested in?`,
      'What are your main priorities or goals for this research?',
      'Are there any specific limitations or constraints we should consider?'
    ].slice(0, numQuestions);
  }
}
