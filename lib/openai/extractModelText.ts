/**
 * Robust Model Text Extraction
 * 
 * Single unified function to extract text from OpenAI API responses.
 * Handles all known response formats (Chat Completions, Responses API, structured outputs).
 * 
 * IMPORTANT: This function only logs safe metadata (lengths, structure) - never logs
 * secrets or full content.
 */

/**
 * Extract text content from OpenAI API response
 * 
 * Handles multiple response formats:
 * 1. Responses API: response.output_text or response.output[].content[].text
 * 2. Chat Completions: response.choices[0].message.content
 * 3. Structured outputs: message.parsed (object, stringified to JSON)
 * 
 * @param response - OpenAI API response object
 * @returns Extracted text content, or null if no extractable content
 */
export function extractModelText(response: any): string | null {
  if (!response) {
    return null;
  }

  // ============================================
  // Responses API Format
  // ============================================
  
  // Priority 1: Direct output_text field (Responses API)
  if (typeof (response as any)?.output_text === 'string') {
    const text = (response as any).output_text.trim();
    if (text.length > 0) {
      return text;
    }
  }
  
  // Priority 2: Structured output array (Responses API)
  if ((response as any)?.output?.[0]?.content && Array.isArray((response as any).output[0].content)) {
    const contentArray = (response as any).output[0].content;
    const textParts: string[] = [];
    
    for (const item of contentArray) {
      if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0) {
        textParts.push(item.text.trim());
      }
    }
    
    if (textParts.length > 0) {
      return textParts.join('\n');
    }
  }

  // ============================================
  // Chat Completions API Format
  // ============================================
  
  if (response?.choices?.[0]?.message) {
    const message = response.choices[0].message;
    
    // Priority 3: Structured output (parsed object)
    if ((message as any)?.parsed && typeof (message as any).parsed === 'object') {
      try {
        return JSON.stringify((message as any).parsed);
      } catch {
        // Fall through to content extraction
      }
    }
    
    // Priority 4: Refusal handling
    if (message.refusal && typeof message.refusal === 'string') {
      // Model refused - return null (no usable content)
      return null;
    }
    
    // Priority 5: Tool calls (not usable for synthesis)
    if (message.tool_calls && message.tool_calls.length > 0) {
      // Tool calls are not usable - return null
      return null;
    }
    
    // Priority 6: Standard content extraction
    if (message.content && typeof message.content === 'string') {
      const trimmed = message.content.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
      
      // Empty content - check for parsed fallback
      if ((message as any)?.parsed) {
        try {
          return JSON.stringify((message as any).parsed);
        } catch {
          // Fall through to null
        }
      }
    }
    
    // Priority 7: Handle finish_reason='length' with empty content
    // Check for parsed content even if message.content is empty
    if (response.choices[0].finish_reason === 'length' && !message.content) {
      if ((message as any)?.parsed) {
        try {
          return JSON.stringify((message as any).parsed);
        } catch {
          // Fall through to null
        }
      }
    }
  }

  // No extractable content found
  return null;
}

