import { composeContext } from "../core/context.ts";
import { log_to_file } from "../core/logger.ts";
import { embeddingZeroVector } from "../core/memory.ts";
import { messageHandlerTemplate } from "../clients/discord/templates.ts";
import {
  Action,
  ActionExample,
  Content,
  IAgentRuntime,
  Message,
  State,
} from "../core/types.ts";
import { parseJSONObjectFromText } from "../core/parsing.ts";

const maxContinuesInARow = 2;

export const shouldContinueTemplate = `# Task: Decide if {{agentName}} should continue, or wait for others in the conversation so speak.

{{agentName}} is brief, and doesn't want to be annoying. {{agentName}} will only continue if the message requires a continuation to finish the thought.

Based on the following conversation, should {{agentName}} continue? YES or NO

{{recentMessages}}

Should {{agentName}} continue? Respond with a YES or a NO.`;

export default {
  name: "CONTINUE",
  description:
    "ONLY use this action when the message necessitates a follow up. Do not use this action when the conversation is finished or the user does not wish to speak (use IGNORE instead). If the last message action was CONTINUE, and the user has not responded. Use sparingly.",
  validate: async (runtime: IAgentRuntime, message: Message) => {
    console.log("Validating continue");
    const recentMessagesData = await runtime.messageManager.getMemories({
      room_id: message.room_id,
      count: 10,
      unique: false,
    });
    const agentMessages = recentMessagesData.filter(
      (m: { user_id: any }) => m.user_id === runtime.agentId,
    );

    // check if the last messages were all continues=
    if (agentMessages) {
      const lastMessages = agentMessages.slice(0, maxContinuesInARow);
      if (lastMessages.length >= maxContinuesInARow) {
        const allContinues = lastMessages.every(
          (m: { content: any }) => (m.content as Content).action === "CONTINUE",
        );
        if (allContinues) {
          return false;
        }
      }
    }

    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Message,
    state: State,
    options: any,
    callback: any,
  ) => {
    if (
      message.content.text.endsWith("?") ||
      message.content.text.endsWith("!")
    ) {
      return;
    }

    if (!state) {
      state = (await runtime.composeState(message)) as State;
    }

    state = await runtime.updateRecentMessageState(state);

    async function _shouldContinue(state: State): Promise<boolean> {
      // If none of the above conditions are met, use the completion to decide
      const shouldRespondContext = composeContext({
        state,
        template: shouldContinueTemplate,
      });

      let response = await runtime.completion({
        context: shouldRespondContext,
        stop: ["\n"],
        max_response_length: 5,
      });

      console.log("*** SHOULD CONTINUE ***", response);

      // Parse the response and determine if the runtime should respond
      const lowerResponse = response.toLowerCase().trim();
      if (lowerResponse.includes("yes")) {
        return true;
      }
      return false;
    }

    const shouldContinue = await _shouldContinue(state);
    if (!shouldContinue) {
      console.log("Not elaborating");
      return;
    }

    const context = composeContext({
      state,
      template: messageHandlerTemplate,
    });
    const datestr = new Date().toISOString().replace(/:/g, "-");

    // log context to file
    log_to_file(`${state.agentName}_${datestr}_continue_context`, context);

    const { user_id, room_id } = message;

    const response = await runtime.messageCompletion({
      context,
      stop: [],
    });

    // log response to file
    log_to_file(
      `${state.agentName}_${datestr}_continue_response`,
      JSON.stringify(response),
    );

    runtime.databaseAdapter.log({
      body: { message, context, response },
      user_id,
      room_id,
      type: "continue",
    });

    // prevent repetition
    const messageExists = state.recentMessagesData
      .filter((m: { user_id: any }) => m.user_id === runtime.agentId)
      .slice(0, maxContinuesInARow + 1)
      .some((m: { content: any }) => m.content === message.content);

    if (messageExists) {
      return;
    }

    const _saveResponseMessage = async (
      message: Message,
      state: State,
      responseContent: Content,
    ) => {
      const { room_id } = message;

      responseContent.content = responseContent.text?.trim();

      if (responseContent.content) {
        console.log("create memory");
        console.log("runtime.agentId");
        console.log(runtime.agentId);
        console.log("responseContent");
        console.log(responseContent);
        console.log("room_id");
        console.log(room_id);
        await runtime.messageManager.createMemory({
          user_id: message.user_id,
          content: responseContent,
          room_id,
          embedding: embeddingZeroVector,
        });
        await runtime.evaluate(message, { ...state, responseContent });
      } else {
        console.warn("Empty response, skipping");
      }
    };

    callback(response);

    await _saveResponseMessage(message, state, response);

    // if the action is CONTINUE, check if we are over maxContinuesInARow
    if (response.action === "CONTINUE") {
      const agentMessages = state.recentMessagesData
        .filter((m: { user_id: any }) => m.user_id === runtime.agentId)
        .map((m: { content: any }) => (m.content as Content).action);

      const lastMessages = agentMessages.slice(0, maxContinuesInARow);
      if (lastMessages.length >= maxContinuesInARow) {
        const allContinues = lastMessages.every(
          (m: string | undefined) => m === "CONTINUE",
        );
        if (allContinues) {
          response.action = null;
        }
      }
    }

    return response;
  },
  condition:
    "Only use CONTINUE if the message requires a continuation to finish the thought. If this actor is waiting for the other actor to respond, or the actor does not have more to say, do not use the CONTINUE action.",
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "we're planning a solo backpacking trip soon",
        },
      },
      {
        user: "{{user2}}",
        content: { text: "oh sick", action: "CONTINUE" },
      },
      {
        user: "{{user2}}",
        content: { text: "where are you going" },
      },
    ],

    [
      {
        user: "{{user1}}",
        content: {
          text: "i just got a guitar and started learning last month",
        },
      },
      {
        user: "{{user2}}",
        content: { text: "maybe we can start a band soon lol" },
      },
      {
        user: "{{user1}}",
        content: {
          content:
            "i'm not very good yet, but i've been playing until my fingers hut",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user1}}",
        content: { text: "seriously lol it hurts to type" },
      },
    ],

    [
      {
        user: "{{user1}}",
        content: {
          content:
            "I've been reflecting a lot on what happiness means to me lately",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "That it’s more about moments than things",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user2}}",
        content: {
          content:
            "Like the best things that have ever happened were things that happened, or moments that I had with someone",
          action: "CONTINUE",
        },
      },
    ],

    [
      {
        user: "{{user1}}",
        content: {
          text: "i found some incredible art today",
        },
      },
      {
        user: "{{user2}}",
        content: { text: "real art or digital art" },
      },
      {
        user: "{{user1}}",
        content: {
          text: "lol real art",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user1}}",
        content: {
          content:
            "the pieces are just so insane looking, one sec, let me grab a link",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user1}}",
        content: { text: "DMed it to you" },
      },
    ],

    [
      {
        user: "{{user1}}",
        content: {
          content:
            "the new exhibit downtown is rly cool, it's all about tribalism in online spaces",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "it really blew my mind, you gotta go",
        },
      },
      {
        user: "{{user2}}",
        content: { text: "lol sure i'd go" },
      },
      {
        user: "{{user1}}",
        content: { text: "k i was thinking this weekend" },
        action: "CONTINUE",
      },
      {
        user: "{{user1}}",
        content: { text: "i'm free sunday, we could get a crew together" },
      },
    ],

    [
      {
        user: "{{user1}}",
        content: {
          text: "just finished the best anime i've ever seen",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "watched 40 hours of it in 2 days",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "damn, u ok",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "surprisingly yes",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "just found out theres a sequel, gg",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "i'm thinking of adopting a pet soon",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "what kind of pet",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "i'm leaning towards a cat",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "it'd be hard to take care of a dog in the city",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "i've been experimenting with vegan recipes lately",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "no thanks",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "no seriously, its so dank",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "you gotta try some of my food when you come out",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "so i've been diving into photography as a new hobby",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "oh awesome, what do you enjoy taking photos of",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "mostly nature and urban landscapes",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user1}}",
        content: {
          content:
            "there's something peaceful about capturing the world through a lens",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "i've been getting back into indie music",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "what have you been listening to",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "a bunch of random stuff i'd never heard before",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "i'll send you a playlist",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "i used to live in the city",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user1}}",
        content: {
          content:
            "bad traffic, bad air quality, tons of homeless people, no thx",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "ok dood",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "you kids today dont know the value of hard work",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "always on your phones",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "sure grandpa lets get you to bed",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "hey fren r u ok",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "u look sad",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "im ok sweetie mommy just tired",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "helo fr om mars",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "i com in pes",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "wat",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Yeah no worries, I get it, I've been crazy busy too",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "What have you been up to",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "Anything fun or just the usual",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "Been working on a new FPS game actually",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user1}}",
        content: {
          content:
            "Just toying around with something in three.js nothing serious",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Oh no, what happened",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user1}}",
        content: {
          text: "Did Mara leave you lol",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "wtf no, I got into an argument with my roommate",
          action: "CONTINUE",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "Living with people is just hard",
        },
      },
    ],
  ] as ActionExample[][],
} as Action;