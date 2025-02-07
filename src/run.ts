import { createInterface } from 'readline';
import { deepResearch } from './core/research-engine';
import { saveToFile } from './utils/file';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

async function askQuestion(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question + '\n> ', (answer) => {
      resolve(answer.trim());
    });
  });
}

function formatReport(query: string, result: any): string {
  const sections = ['# Deep Research Report\n'];
  
  // Add query and timestamp
  sections.push(`**Query:** ${query}`);
  sections.push(`**Date:** ${new Date().toLocaleString()}\n`);
  
  // Add search queries if available
  if (result.searchQueries?.length > 0) {
    sections.push('## Search Queries Used');
    result.searchQueries.forEach((q: string, i: number) => {
      sections.push(`${i + 1}. ${q}`);
    });
    sections.push('');
  }

  // Add the report content
  if (result.report) {
    // Executive Summary
    sections.push('## Executive Summary');
    sections.push(result.report.executiveSummary);
    sections.push('');

    // Key Findings
    if (result.report.keyFindings?.length > 0) {
      sections.push('## Key Findings');
      result.report.keyFindings.forEach((finding: any, i: number) => {
        sections.push(`### ${i + 1}. ${finding.title}`);
        finding.details.forEach((detail: string) => {
          sections.push(`- ${detail}`);
        });
        sections.push('');
      });
    }

    // Sources
    if (result.report.sources?.length > 0) {
      sections.push('## Sources');
      result.report.sources.forEach((source: string, i: number) => {
        sections.push(`${i + 1}. ${source}`);
      });
    }
  }

  // Add error if present
  if (result.error) {
    sections.push('\n## Errors');
    sections.push(`⚠️ ${result.error}`);
  }

  return sections.join('\n');
}

async function main() {
  try {
    // Get research query
    const query = await askQuestion('\n📚 What would you like to research?');
    if (!query) {
      console.error('Please provide a research query');
      process.exit(1);
    }

    // Get research parameters
    const breadthStr = await askQuestion('\n🌳 Research breadth (3-10, default: 6):');
    const depthStr = await askQuestion('\n🏊‍♂️ Research depth (1-5, default: 3):');

    const breadth = Math.min(10, Math.max(1, parseInt(breadthStr) || 6));
    const depth = Math.min(5, Math.max(1, parseInt(depthStr) || 3));

    // Generate initial feedback questions
    console.log('\n🤔 Let me ask you a few questions to better understand your research needs...');
    
    // Run initial research to get feedback questions
    const initialResult = await deepResearch(query, 1, 1);
    
    // Ask feedback questions and collect answers
    const answers: string[] = [];
    if (initialResult.feedbackQuestions?.length > 0) {
      for (const question of initialResult.feedbackQuestions) {
        const answer = await askQuestion(`\n${question}`);
        answers.push(answer);
      }
    }

    // Build enhanced query with context from answers
    const enhancedQuery = `
Original Query: ${query}

Context from user:
${initialResult.feedbackQuestions?.map((q, i) => `Q: ${q}\nA: ${answers[i]}`).join('\n')}
    `.trim();

    console.log('\n🔍 Thanks! Now I\'ll start the deep research with your context...');

    // Run the research with enhanced query
    const result = await deepResearch(enhancedQuery, breadth, depth);

    // Format the results
    const formattedReport = formatReport(query, result);
    
    // Save to file
    const sanitizedQuery = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    const filename = `research-${sanitizedQuery}-${new Date().toISOString().split('T')[0]}.md`;
    await saveToFile(formattedReport, filename);

    // Display in terminal
    console.log('\n📝 Research Results\n');
    console.log(formattedReport);

  } catch (e) {
    console.error('\n❌ An error occurred:', e);
  } finally {
    rl.close();
  }
}

// Run the program
main();
