/**
 * OpenAI Response Extraction Utilities
 * 
 * Safely extracts text content from OpenAI API responses, handling multiple response formats:
 * - Chat Completions API: choices[0].message.content
 * - Structured outputs: message.parsed (object)
 * - Responses API: output_text or output[0].content[].text
 * - Tool calls: returns null (not usable for synthesis)
 * - Refusals: returns null (model refused to respond)
 * 
 * This module centralizes extraction logic to handle edge cases and API format changes.
 */

/**
 * Extract text content or structured object from OpenAI response
 * 
 * Supports multiple OpenAI API response formats:
 * - Chat Completions API (standard): resp.choices[0].message.content
 * - Structured outputs: message.parsed (when using response_format with schemas)
 * - Responses API: resp.output_text or resp.output[0].content[].text
 * - Tool calls: returns null (should not happen with our config)
 * - Refusals: returns null (model refused to respond)
 * 
 * CRITICAL: This function logs unknown response shapes for debugging.
 * If you see "Unknown response shape" logs, OpenAI may have changed their format.
 * 
 * @param resp - OpenAI API response object (any shape)
 * @returns Extracted text content (JSON string if parsed object, plain string if content), or null if no extractable content
 */
export function extractOpenAIText(resp: any): string | null {
  if (!resp) {
    console.warn("[extractOpenAIText] Response is null/undefined");
    return null;
  }

  // Chat Completions API format (standard) - most common
  if (resp?.choices?.[0]?.message) {
    const message = resp.choices[0].message;
    
    // Priority 1: Check for structured output (parsed object) - for structured outputs feature
    // This is used when OpenAI returns a parsed object instead of raw JSON string
    if ((message as any)?.parsed && typeof (message as any).parsed === 'object') {
      try {
        const parsedJson = JSON.stringify((message as any).parsed);
        console.log("[extractOpenAIText] Extracted from message.parsed (structured output)");
        return parsedJson;
      } catch (e) {
        console.warn("[extractOpenAIText] Failed to stringify message.parsed:", e);
        // Fall through to content extraction
      }
    }
    
    // Priority 2: Check for refusal (model refused to respond)
    // This is distinct from empty content - model explicitly refused
    if (message.refusal && typeof message.refusal === 'string') {
      console.warn("[extractOpenAIText] Model refused to respond", {
        refusal: message.refusal,
        finishReason: resp.choices[0].finish_reason,
      });
      return null; // Treat refusal as no usable content
    }
    
    // Priority 3: Check for tool_calls (should not happen with our config, but handle it)
    // Tool calls indicate the model tried to use a function/tool instead of returning text
    if (message.tool_calls && message.tool_calls.length > 0) {
      console.warn("[extractOpenAIText] Response contains tool_calls but no content", {
        toolCallsCount: message.tool_calls.length,
        finishReason: resp.choices[0].finish_reason,
        hasContent: !!message.content,
      });
      return null; // Tool calls are not usable for synthesis
    }
    
    // Priority 4: Standard content extraction (most common path)
    if (message.content && typeof message.content === 'string') {
      const trimmed = message.content.trim();
      if (trimmed.length > 0) {
        console.log("[extractOpenAIText] Extracted from message.content");
        return trimmed;
      }
      // Empty string content - check if we have parsed fallback
      if ((message as any)?.parsed) {
        try {
          const parsedJson = JSON.stringify((message as any).parsed);
          console.log("[extractOpenAIText] Empty content, using message.parsed fallback");
          return parsedJson;
        } catch (e) {
          // Fall through to null
        }
      }
      return null;
    }
    
    // Priority 5: Handle finish_reason='length' with null content
    // If model hit token limit but we have parsed content, use it
    if (resp.choices[0].finish_reason === 'length' && !message.content) {
      console.warn("[extractOpenAIText] Response hit token limit (finish_reason: length), checking for parsed content", {
        hasParsed: !!(message as any)?.parsed,
        hasToolCalls: !!message.tool_calls,
      });
      // If we have parsed content even with length limit, return it (partial is better than nothing)
      if ((message as any)?.parsed) {
        try {
          const parsedJson = JSON.stringify((message as any).parsed);
          console.log("[extractOpenAIText] Extracted partial content from message.parsed (hit length limit)");
          return parsedJson;
        } catch (e) {
          console.warn("[extractOpenAIText] Failed to stringify parsed content after length limit:", e);
          // Fall through to null
        }
      }
      return null;
    }
    
    // Unknown message shape - log for debugging
    console.warn("[extractOpenAIText] Unknown message shape in Chat Completions format", {
      messageKeys: Object.keys(message),
      hasContent: !!message.content,
      hasParsed: !!(message as any)?.parsed,
      hasRefusal: !!message.refusal,
      hasToolCalls: !!message.tool_calls,
      finishReason: resp.choices[0].finish_reason,
    });
  }
  
  // Responses API format (alternative format - less common)
  if (typeof (resp as any)?.output_text === 'string') {
    const trimmed = (resp as any).output_text.trim();
    if (trimmed.length > 0) {
      console.log("[extractOpenAIText] Extracted from output_text (Responses API)");
      return trimmed;
    }
  }
  
  // Responses API with structured output
  if ((resp as any)?.output?.[0]?.content) {
    const contentArray = (resp as any).output[0].content;
    if (Array.isArray(contentArray)) {
      // Find text content in content array
      for (const item of contentArray) {
        if (item.type === 'text' && typeof item.text === 'string') {
          const trimmed = item.text.trim();
          if (trimmed.length > 0) {
            console.log("[extractOpenAIText] Extracted from output[0].content[].text (Responses API)");
            return trimmed;
          }
        }
      }
    }
  }
  
  // Unknown response shape - log full structure for debugging
  console.error("[extractOpenAIText] Unknown response shape - could not extract content", {
    responseKeys: resp ? Object.keys(resp) : [],
    hasChoices: !!resp?.choices,
    choicesLength: resp?.choices?.length,
    hasOutputText: typeof (resp as any)?.output_text !== 'undefined',
    hasOutput: !!(resp as any)?.output,
    responseType: typeof resp,
  });
  
  return null;
}

/**
 * Check if OpenAI response indicates partial content (hit token limit)
 * 
 * @param resp - OpenAI API response object
 * @returns True if finish_reason is 'length' (model hit max_tokens/max_completion_tokens limit)
 */
export function isPartialResponse(resp: any): boolean {
  return resp?.choices?.[0]?.finish_reason === 'length';
}

