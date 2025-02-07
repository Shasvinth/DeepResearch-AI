import { GoogleGenerativeAI } from '@google/generative-ai';
import { generateFeedback } from './feedback';
import { searchWeb } from './web-search';
import pLimit from 'p-limit';

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// Rate limit to 2 concurrent requests to avoid hitting API limits
const limit = pLimit(2);

// Helper function to delay execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to retry a function with exponential backoff
async function retry<T>(
  fn: () => Promise<T>,
  retries = 3,
  baseDelay = 2000,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (retries === 0) throw e;
    
    // If we hit rate limits, wait longer
    const isRateLimit = e.message?.includes('429') || e.message?.includes('quota');
    const waitTime = isRateLimit ? baseDelay * 4 : baseDelay;
    
    console.log(`Rate limit hit, waiting ${waitTime/1000}s before retry...`);
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

async function generateSerpQueries(query: string, breadth: number): Promise<string[]> {
  try {
    console.log('\n🔍 Generating search queries...');
    
    const prompt = `Given this research query: "${query}"

Generate ${breadth} unique search queries that will help gather comprehensive information.
The queries should cover different aspects and use varied search terms for better results.

Format your response as a JSON object like this:
{
  "queries": [
    "detailed comparison iPhone 14 Pro Max vs iPhone 16 Pro Max camera features",
    "iPhone 16 Pro Max expected battery life improvements",
    "major upgrades iPhone 14 Pro Max to iPhone 16 Pro Max worth it"
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

    const jsonStr = extractJSON(text);
    if (!jsonStr) {
      throw new Error('No JSON found in response');
    }

    console.log('\nExtracted JSON:', jsonStr);
    
    const parsed = JSON.parse(jsonStr);
    const validQueries = parsed.queries
      .filter(q => typeof q === 'string' && q.trim().length > 0)
      .map(q => q.trim())
      .slice(0, breadth);

    if (validQueries.length === 0) {
      throw new Error('No valid queries found in response');
    }

    return validQueries;
  } catch (e) {
    console.error('\nError generating search queries:', e);
    // Return simple variations of the original query
    return [
      query,
      `${query} comparison`,
      `${query} review`,
      `${query} worth it`
    ].slice(0, breadth);
  }
}

async function processContents(query: string, contents: string[]): Promise<{
  summary: string;
  keyFindings: {
    title: string;
    details: string[];
  }[];
  sources: string[];
}> {
  try {
    console.log('\n📊 Analyzing search results...');
    
    // Split contents into smaller chunks to avoid token limits
    const maxChunkSize = 15000;
    const chunks: string[] = [];
    let currentChunk = '';
    
    for (const content of contents) {
      if (currentChunk.length + content.length > maxChunkSize) {
        chunks.push(currentChunk);
        currentChunk = content;
      } else {
        currentChunk += '\n\n' + content;
      }
    }
    if (currentChunk) {
      chunks.push(currentChunk);
    }
    
    console.log(`Processing ${chunks.length} content chunks...`);
    
    // Process chunks sequentially to avoid rate limits
    const chunkResults = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`\nProcessing chunk ${i + 1}/${chunks.length}...`);
      
      const prompt = `Analyze these search results about: "${query}"

Search Results:
${chunk}

Create a comprehensive analysis with the following structure:
{
  "summary": "A concise executive summary of the key insights",
  "keyFindings": [
    {
      "title": "Finding Category/Title",
      "details": [
        "Specific detail or insight 1",
        "Specific detail or insight 2"
      ]
    }
  ],
  "sources": [
    "Brief description of source 1",
    "Brief description of source 2"
  ]
}

Make the analysis detailed but concise. Group related findings together.
IMPORTANT: Return ONLY the JSON object, no other text.`;

      try {
        // Use rate limiting and retries
        const result = await limit(() => 
          retry(async () => {
            const response = await model.generateContent(prompt);
            return response;
          })
        );
        
        const text = result.response.text();
        console.log(`\nRaw response for chunk ${i + 1}:`, text);

        const jsonStr = extractJSON(text);
        if (!jsonStr) {
          console.log(`No JSON found in response for chunk ${i + 1}, skipping...`);
          continue;
        }

        const parsed = JSON.parse(jsonStr);
        if (parsed.summary && parsed.keyFindings) {
          chunkResults.push(parsed);
        }

        // Add delay between chunks to avoid rate limits
        if (i < chunks.length - 1) {
          await delay(2000);
        }
      } catch (e) {
        console.error(`Error processing chunk ${i + 1}:`, e);
        continue;
      }
    }
    
    if (chunkResults.length === 0) {
      throw new Error('No valid results from any chunks');
    }
    
    // Merge results from all chunks
    const merged = {
      summary: chunkResults.map(r => r.summary).join('\n\n'),
      keyFindings: chunkResults.flatMap(r => r.keyFindings),
      sources: chunkResults.flatMap(r => r.sources)
    };
    
    // Deduplicate and clean up
    return {
      summary: merged.summary,
      keyFindings: merged.keyFindings
        .filter((f, i, arr) => 
          arr.findIndex(g => g.title === f.title) === i
        ),
      sources: [...new Set(merged.sources)]
    };
  } catch (e) {
    console.error('\nError processing search results:', e);
    return {
      summary: 'Error analyzing results. Here are the raw findings:',
      keyFindings: [{
        title: 'Raw Results',
        details: contents.map(c => c.substring(0, 200) + '...')
      }],
      sources: ['Error processing sources']
    };
  }
}

export async function deepResearch(query: string, breadth: number, depth: number) {
  try {
    console.log('\n🚀 Starting deep research...');
    console.log(`Query: "${query}"`);
    console.log(`Breadth: ${breadth}, Depth: ${depth}`);

    // For initial feedback questions, use minimal parameters
    if (breadth === 1 && depth === 1) {
      const feedbackQuestions = await generateFeedback({ query, numQuestions: 3 });
      return {
        query,
        feedbackQuestions,
        searchQueries: [],
        report: {
          executiveSummary: '',
          keyFindings: [],
          sources: []
        }
      };
    }

    // Generate search queries
    const searchQueries = await generateSerpQueries(query, breadth);
    
    // Perform searches sequentially to avoid rate limits
    console.log('\n🌐 Searching the web...');
    const searchResults = [];
    for (let i = 0; i < searchQueries.length; i++) {
      const results = await searchWeb(searchQueries[i], depth);
      searchResults.push(results);
      
      // Add delay between searches
      if (i < searchQueries.length - 1) {
        await delay(1000);
      }
    }
    
    // Flatten and process results
    const allContents = searchResults.flat();
    const analysis = await processContents(query, allContents);
    
    // Format the final report
    return {
      query,
      searchQueries,
      report: {
        executiveSummary: analysis.summary,
        keyFindings: analysis.keyFindings,
        sources: analysis.sources
      }
    };
  } catch (e) {
    console.error('\n❌ Error in deep research:', e);
    return {
      query,
      error: `Research failed: ${e.message}`,
      searchQueries: [],
      report: {
        executiveSummary: 'Research could not be completed due to an error.',
        keyFindings: [],
        sources: []
      }
    };
  }
}
