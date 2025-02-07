import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

export async function saveToFile(content: string, filename: string) {
  try {
    // Create output directory if it doesn't exist
    const outputDir = join(process.cwd(), 'output');
    await mkdir(outputDir, { recursive: true });

    // Generate a filename with timestamp if not provided
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const finalFilename = filename || `research-${timestamp}.md`;
    
    // Ensure .md extension
    const fileWithExt = finalFilename.endsWith('.md') ? finalFilename : `${finalFilename}.md`;
    const filepath = join(outputDir, fileWithExt);

    // Save the file
    await writeFile(filepath, content);
    console.log(`\n✨ Report saved to: ${filepath}`);
    
    return filepath;
  } catch (error) {
    console.error('\n❌ Error saving file:', error);
    throw error;
  }
} 