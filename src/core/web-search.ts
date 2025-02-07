import FirecrawlApp from '@mendable/firecrawl-js';
import { compact } from 'lodash-es';
import { trimPrompt } from '../models/providers/ai-models';
import pLimit from 'p-limit';

// Initialize Firecrawl with optional API key and optional base url
const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_KEY ?? '',
  apiUrl: process.env.FIRECRAWL_BASE_URL,
});

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
    const isRateLimit = e.statusCode === 429;
    const waitTime = isRateLimit ? baseDelay * 4 : baseDelay;
    
    // Extract reset time from error message if available
    let resetTime = '';
    if (isRateLimit && e.message) {
      const match = e.message.match(/resets at ([^)]+)/);
      if (match) resetTime = ` (resets at ${match[1]})`;
    }
    
    console.log(`Rate limit hit, waiting ${waitTime/1000}s before retry${resetTime}...`);
    await delay(waitTime);
    
    return retry(fn, retries - 1, waitTime * 2);
  }
}

export async function searchWeb(query: string, depth: number): Promise<string[]> {
  try {
    console.log(`\n🔎 Searching for: "${query}"`);
    
    // Use rate limiting and retries
    const result = await limit(() => 
      retry(async () => {
        const searchResult = await firecrawl.search(query, {
          timeout: 30000, // Increased timeout
          limit: Math.min(depth * 2, 5), // Limit results to avoid rate limits
          scrapeOptions: { formats: ['markdown'] },
        });
        return searchResult;
      })
    );

    // Extract and clean the content
    const contents = compact(result.data.map(item => {
      const content = item.markdown;
      if (!content) return null;
      
      // Trim the content to a reasonable size
      return trimPrompt(content, 15_000); // Reduced size to avoid token limits
    }));

    // Add a small delay between searches to avoid rate limits
    await delay(1000);

    console.log(`Found ${contents.length} relevant results`);
    return contents;
  } catch (e) {
    console.error(`\n⚠️ Error searching for "${query}":`, e);
    // Return an empty array but don't fail the whole process
    return [];
  }
} 