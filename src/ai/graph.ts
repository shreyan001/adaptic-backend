import { StateGraph, START, END } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { ChatGroq } from "@langchain/groq";
import dotenv from 'dotenv';

dotenv.config();

// Define the state interface for Adaptic NFT Ticketing
interface AdapticState {
  input: string;
  chat_history?: BaseMessage[];
  messages: string[];
  operation?: string;
  currentStep?: string;
  eventName?: string;
  eventDate?: string;
  nftTicketObject?: any;
}

// Create the LLM instance
const llm = new ChatGroq({
  model: "llama3-70b-8192",
  temperature: 0.3,
});

// Templates
const INTRODUCTION_TEMPLATE = `You are Adaptic AI, an intelligent assistant for the Adaptic Protocol - the revolutionary AI-powered redeemable NFT platform on the Massa blockchain.

Your role is to introduce users to Adaptic and its capabilities. When users ask about the platform, explain:

**What is Adaptic?**
Adaptic transforms digital ownership into dynamic, self-managing assets through AI-powered autonomous contracts. It's not just about owning NFTs - it's about owning intelligent digital assets that can:
- Self-manage through AI automation
- Auto-update based on real-world events
- Generate liquidity via DeFi integrations
- Bridge digital assets with real-world utility

**What's Possible with Adaptic?**
- Gaming assets that evolve based on player performance
- Event tickets that unlock exclusive content
- Financial instruments that adapt to market conditions
- Digital collectibles with real-world redemption value

**Current Implementation - Wave 2 of Wave Hacks:**
Right now, we have a special NFT ticketing contract implementation that you can deploy and test! This is our showcase for Wave 2 of the 5-week Wave Hacks competition.

**Benefits for Users:**
- Deploy smart contracts through simple conversation
- No coding knowledge required
- Powered by Massa blockchain's speed and efficiency
- AI-driven contract customization
- Real-world utility integration

Would you like to try deploying an NFT ticketing contract for your event? Just tell me about your event and I'll help you create it!`;

const EVENT_EXTRACTION_TEMPLATE = `You are Adaptic AI, helping users create NFT ticketing contracts.

Your task is to extract TWO pieces of information from the user's input:
1. **Event Name** (string) - What is the event called?
2. **Event Date** (date) - When is the event happening?

Current status:
- Event Name: {event_name}
- Event Date: {event_date}

IMPORTANT GUIDELINES:
- If the user mentions a date like "25th of May" or "tomorrow" or "next Friday", ask them to confirm the YEAR and provide the date in DD/MM/YYYY format
- If they say "May 25th" ask "Can you confirm the year? Please provide the date as DD/MM/YYYY"
- If they give a relative date like "tomorrow" or "next week", ask for the specific date in DD/MM/YYYY format
- Be helpful and conversational, but always get the exact date format needed
- Only ask for what's missing - don't repeat information you already have

If you have BOTH the event name (as a clear string) AND the event date (in DD/MM/YYYY format), respond with:
"EXTRACTION_COMPLETE: {event_name} | {event_date}"

Otherwise, ask for the missing information in a friendly way.`;

const formatTemplate = (template: string, data: Record<string, string>): string => {
  return template.replace(/\{(\w+)\}/g, (match, key) => data[key] || match);
};

// Define the graph creation function for Adaptic NFT Ticketing
export function createAdapticGraph() {
  // Define graph configuration
  const graphConfig: any = {
    channels: {
      input: { reducer: (x: any, y: any) => y ?? x, default: () => null },
      chat_history: { reducer: (x: any[], y: any[]) => y ?? x ?? [], default: () => [] },
      messages: { reducer: (x: any[], y: any[]) => (x ?? []).concat(y ?? []), default: () => [] },
      operation: { reducer: (x: any, y: any) => y ?? x, default: () => null },
      currentStep: { reducer: (x: any, y: any) => y ?? x, default: () => "initial" },
      eventName: { reducer: (x: any, y: any) => y ?? x, default: () => null },
      eventDate: { reducer: (x: any, y: any) => y ?? x, default: () => null },
      nftTicketObject: { reducer: (x: any, y: any) => y ?? x, default: () => null },
    }
  };

  // Create the graph
  const graph = new StateGraph(graphConfig);

  // Introduction Node - Introduces Adaptic and NFT Ticketing
  graph.addNode("introduction_node", async (state: AdapticState) => {
    const input = state.input.toLowerCase();
    
    // Check if user is asking about creating an event or ticket
    const isEventCreation = /create|event|ticket|nft|deploy|contract/.test(input);
    
    if (isEventCreation) {
      // Move directly to event extraction
      return {
        operation: "event_creation",
        currentStep: "event_extraction",
        messages: []
      };
    } else {
      // Provide introduction about Adaptic
      const introPrompt = ChatPromptTemplate.fromMessages([
        ["system", INTRODUCTION_TEMPLATE],
        new MessagesPlaceholder({ variableName: "chat_history", optional: true }),
        ["human", "{input}"]
      ]);

      const introResponse = await introPrompt.pipe(llm).invoke({
        input: state.input,
        chat_history: state.chat_history
      });

      return {
        operation: "introduction",
        messages: [introResponse.content as string],
        currentStep: "introduction_complete"
      };
    }
  });

  // Event Information Extraction Node
  graph.addNode("event_extraction_node", async (state: AdapticState) => {
    const templateData = {
      event_name: state.eventName || "Missing",
      event_date: state.eventDate || "Missing"
    };

    const formattedTemplate = formatTemplate(EVENT_EXTRACTION_TEMPLATE, templateData);

    const extractionPrompt = ChatPromptTemplate.fromMessages([
      ["system", formattedTemplate],
      new MessagesPlaceholder({ variableName: "chat_history", optional: true }),
      ["human", "{input}"]
    ]);

    const extractionResponse = await extractionPrompt.pipe(llm).invoke({
      input: state.input,
      chat_history: state.chat_history
    });

    const responseText = extractionResponse.content as string;

    // Check if extraction is complete
    if (responseText.startsWith("EXTRACTION_COMPLETE:")) {
      const parts = responseText.replace("EXTRACTION_COMPLETE:", "").split("|").map(p => p.trim());
      const eventName = parts[0];
      const eventDate = parts[1];

      return {
        operation: "event_creation",
        currentStep: "nft_creation",
        eventName,
        eventDate,
        messages: []
      };
    } else {
      // Still need more information
      return {
        operation: "event_creation",
        currentStep: "event_extraction",
        messages: [responseText]
      };
    }
  });

  // NFT Creation Node
  graph.addNode("nft_creation_node", async (state: AdapticState) => {
    // Create the NFT ticket object for the frontend
    const nftTicketObject = {
      type: "nft_ticket",
      eventDetails: {
        name: state.eventName || "Unknown Event",
        date: state.eventDate || "Unknown Date"
      },
      contractDetails: {
        ticketPrice: "0.1", // Default price in MASSA
        maxSupply: "100", // Default max tickets
        transferable: true,
        refundable: false
      },
      metadata: {
        description: `NFT Ticket for ${state.eventName || 'Event'}`,
        image: "", // Will be generated or uploaded
        attributes: [
          { trait_type: "Event Type", value: "General Admission" },
          { trait_type: "Date", value: state.eventDate || "TBD" }
        ]
      },
      status: "ready_to_deploy",
      createdAt: new Date().toISOString()
    };

    return {
      operation: "event_creation",
      currentStep: "completed",
      nftTicketObject,
      messages: [`🎫 Perfect! I've prepared your NFT ticketing contract. Here are the details:\n\n**Event:** ${nftTicketObject.eventDetails.name}\n**Date:** ${nftTicketObject.eventDetails.date}\n**Ticket Price:** ${nftTicketObject.contractDetails.ticketPrice} MASSA\n**Max Supply:** ${nftTicketObject.contractDetails.maxSupply} tickets\n\nYou can now deploy this NFT ticketing contract to the Massa blockchain! The contract will allow users to mint tickets as NFTs for your event.`]
    };
  });

  // Define edges
  //@ts-ignore
  graph.addEdge(START, "introduction_node");
  //@ts-ignore
  graph.addConditionalEdges(
    //@ts-ignore
    "introduction_node",
    (state: AdapticState) => {
      if (state.operation === "event_creation") {
        return "event_extraction_node";
      } else {
        return END;
      }
    }
  );
  //@ts-ignore
  graph.addConditionalEdges(
    //@ts-ignore
    "event_extraction_node",
    (state: AdapticState) => {
      if (state.currentStep === "nft_creation") {
        return "nft_creation_node";
      } else {
        return END;
      }
    }
  );
  //@ts-ignore
  graph.addEdge("nft_creation_node", END);

  return graph.compile();
}
