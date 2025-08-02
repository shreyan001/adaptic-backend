import express, { Request, Response } from 'express';
import cors from 'cors';
import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { EventEmitter } from 'events';

// Increase max listeners significantly to handle LangChain's internal listeners
EventEmitter.defaultMaxListeners = 100;
process.setMaxListeners(100);

// Handle AbortSignal specifically
if (typeof AbortSignal !== 'undefined' && AbortSignal.prototype.addEventListener) {
  const originalAddEventListener = AbortSignal.prototype.addEventListener;
  AbortSignal.prototype.addEventListener = function(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) {
    if ((this as any)._maxListeners === undefined) {
      (this as any)._maxListeners = 100;
    }
    return originalAddEventListener.call(this, type, listener, options);
  };
}

// Import the actual nodegraph implementation
import { createAdapticGraph as getActualLangGraph } from './ai/graph';

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Helper function to convert chat history
const convertChatHistoryToMessages = (
  chat_history: [role: string, content: string][],
): BaseMessage[] => {
  return chat_history.map(([role, content]) => {
    switch (role.toLowerCase()) {
      case "human":
        return new HumanMessage(content);
      case "assistant":
      case "ai":
        return new AIMessage(content);
      default:
        console.warn(`Unknown role "${role}" in chat history. Treating as human message.`);
        return new HumanMessage(content); 
    }
  });
};

// Get the compiled graph
const getLangGraph = () => {
  // Create a fresh graph instance for each request to prevent listener accumulation
  try {
    return getActualLangGraph();
  } catch (error) {
    console.error('Error creating LangGraph:', error);
    throw error;
  }
};

// API Endpoint for Chat Agent
app.get('/api/agent', async (req: Request, res: Response) => {
  // Create a request-specific AbortController to manage cancellation
  const requestController = new AbortController();
  const requestSignal = requestController.signal;

  // Clean up on client disconnect
  req.on('close', () => {
    requestController.abort();
  });

  // Set timeout for long-running requests
  const timeoutId = setTimeout(() => {
    requestController.abort();
  }, 120000); // 2 minutes timeout

  const { input, chat_history: chatHistoryString } = req.query;

  if (typeof input !== 'string' || !input) {
    return res.status(400).json({ error: 'Input query parameter is required' });
  }

  let parsedChatHistory: [role: string, content: string][] = [];
  if (typeof chatHistoryString === 'string' && chatHistoryString) {
    try {
      parsedChatHistory = JSON.parse(chatHistoryString);
      if (!Array.isArray(parsedChatHistory)) {
        throw new Error('Chat history must be an array.');
      }
    } catch (error: any) {
      console.warn('Invalid chat_history format:', chatHistoryString, error.message);
      return res.status(400).json({ error: `Invalid chat_history format: ${error.message}` });
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  
  let initialNodeComplete = false;
  try {
    const graph = getLangGraph();
    
    // Prepare initial state
    const initialState: any = {
      input,
      chat_history: convertChatHistoryToMessages(parsedChatHistory),
    };

    // @ts-ignore - The graph stream types are not properly inferred
    const stream = await graph.stream(
      initialState,
      {
        streamMode: "updates",
        recursionLimit: 100,
      }
    );    let hasSentLoadingIndicator = false;

    for await (const value of stream) {
      if (process.env.NODE_ENV === 'development') {
        console.warn("LangGraph Stream Update:", JSON.stringify(value, null, 2));
      }
      
      for (const [nodeName, nodeOutput] of Object.entries(value)) {
        const output = nodeOutput as any;
        
        if (nodeName === 'initial_node' && !hasSentLoadingIndicator) {
          sendEvent({ 
            type: "loading",
            content: "Processing your request...",
            wager: null
          });
          hasSentLoadingIndicator = true;
        }
        
        if (output?.messages?.[0]) {
          const message = output.messages[0];
          
          // Check if this is a wager object message
          const wagerObjectMatch = message.match(/\[OBJ\](.*?)\[\/OBJ\]/);
          if (wagerObjectMatch && nodeName === "wager_validation_node") {
            try {
              const wagerObject = JSON.parse(wagerObjectMatch[1]);
              // Send wager type message with the wager object
              sendEvent({
                type: "wager",
                content: "Wager created successfully!",
                wager: wagerObject
              });
            } catch (error) {
              console.error('Error parsing wager object:', error);
              sendEvent({
                type: "message",
                content: "Error creating wager object",
                wager: null
              });
            }
          } else if (nodeName === "initial_node") {
            // Send regular message type
            sendEvent({
              type: "message",
              content: message,
              wager: null
            });
            initialNodeComplete = true;
          } else if (nodeName === "wager_info_extraction_node" || nodeName === "event_details_extraction_node") {
            // Send message asking for more info
            sendEvent({
              type: "message",
              content: message,
              wager: null
            });
          }
        }
      }
    }    // Send stream end event
    sendEvent({ type: "end" });
  } catch (error: any) {
    console.error('Error during LangGraph stream:', error);
    
    // Always send a message to the frontend, even if there's an error
    if (!initialNodeComplete) {
      sendEvent({
        type: "message",
        content: "I apologize, but I encountered an error processing your request. Please try again.",
        wager: null
      });
    }
    
    sendEvent({ type: "error", payload: { message: error.message || "An error occurred on the server." } });
    sendEvent({ type: "end" });
  } finally {
    // Clean up request-specific resources
    clearTimeout(timeoutId);
    if (!requestSignal.aborted) {
      requestController.abort();
    }
    res.end();
  }
});

app.listen(port, () => {
  console.warn(`Backend server listening at http://localhost:${port}`);
  console.warn(`Try: http://localhost:${port}/api/agent?input=hello&chat_history=[]`);
});

// Periodic cleanup to prevent listener accumulation
setInterval(() => {
  // Force garbage collection of unused listeners
  if (global.gc) {
    global.gc();
  }
}, 60000); // Every minute

// Graceful shutdown handling
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT. Graceful shutdown...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM. Graceful shutdown...');
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

