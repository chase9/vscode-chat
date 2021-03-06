import * as vscode from "vscode";
import { ExtensionContext } from "vscode";
import WebviewContainer from "../webview";
import { ExtensionMessage, UIMessage } from "../types";
import {
  SLASH_COMMANDS,
  REVERSE_SLASH_COMMANDS,
  SelfCommands
} from "../constants";
import * as str from "../strings";
import Logger from "../logger";
import CommandDispatch, { MessageCommand } from "./commands";
import markdownTransform from "./markdowner";

export const getCommand = (text: string): MessageCommand => {
  const pattern = /^\/(\w+) (\w+)$/;
  const trimmed = text.trim();
  const matched = trimmed.match(pattern);

  if (matched) {
    return { namespace: matched[1], subcommand: matched[2] };
  }
};

/**
 * Handles message passing between the UI and extension
 */
class ViewController {
  ui: WebviewContainer | undefined;
  isUIReady: Boolean = false; // Vuejs loaded
  pendingMessage: UIMessage = undefined;

  constructor(
    private context: ExtensionContext,
    private onUIVisible: () => void,
    private onUIFocus: () => void
  ) {}

  isUILoaded = () => !!this.ui;

  loadUi = () => {
    if (this.ui) {
      this.ui.reveal();
    } else {
      const { extensionPath } = this.context;
      this.ui = new WebviewContainer(
        extensionPath,
        () => {
          this.ui = undefined;
          this.isUIReady = false;
        },
        isVisible => (isVisible ? this.onUIVisible() : null)
      );
      this.ui.setMessageHandler(this.sendToExtension);
    }
  };

  dispatchCommand(command: MessageCommand) {
    const handler = new CommandDispatch();

    handler.handle(command).then(result => {
      if (!!result) {
        const { sendToSlack, response } = result;
        if (sendToSlack && response) {
          this.sendTextMessage(response);
        }
      }
    });
  }

  isValidCommand = (text: string, commandList: Object) => {
    const parsed = getCommand(text);

    if (parsed) {
      const { namespace, subcommand } = parsed;

      if (namespace in commandList) {
        const subcommands = Object.keys(commandList[namespace]);
        return subcommands.indexOf(subcommand) >= 0;
      }
    }

    return false;
  };

  isValidReverseCommand = (text: string) => {
    return this.isValidCommand(text, REVERSE_SLASH_COMMANDS);
  };

  handleCommand = (text: string) => {
    if (this.isValidCommand(text, SLASH_COMMANDS)) {
      const parsed = getCommand(text);
      const { namespace, subcommand } = parsed;

      if (namespace === "live" && subcommand === "share") {
        // Temporary bypass for "/live share" till we move
        // all of this to the common command handlers
        return vscode.commands.executeCommand(SelfCommands.LIVE_SHARE_SLASH);
      } else {
        return this.dispatchCommand(parsed);
      }
    }

    if (this.isValidReverseCommand(text)) {
      return this.sendTextMessage(text);
    }

    // TODO(arjun): if not valid, then we need to parse and make a chat.command
    // API call, instead of sending it as a simple text message.
    // Docs: https://github.com/ErikKalkoken/slackApiDoc/blob/master/chat.command.md
    return this.sendTextMessage(text);
  };

  handleInternal = (message: any) => {
    const { text } = message;

    if (text === "is_ready") {
      this.isUIReady = true;
      return this.pendingMessage ? this.sendToUI(this.pendingMessage) : null;
    }

    if (text === "is_focused") {
      this.onUIFocus();
    }

    if (text === "fetch_replies") {
      const { parentTimestamp } = message;
      vscode.commands.executeCommand(
        SelfCommands.FETCH_REPLIES,
        parentTimestamp
      );
    }
  };

  sendTextMessage = (text: string) => {
    return vscode.commands.executeCommand(SelfCommands.SEND_MESSAGE, { text });
  };

  sendThreadReply = (payload: any) => {
    const { text, parentTimestamp } = payload;
    return vscode.commands.executeCommand(SelfCommands.SEND_THREAD_REPLY, {
      text,
      parentTimestamp
    });
  };

  sendToExtension = (message: ExtensionMessage) => {
    const { type, text } = message;
    Logger.log(`Sending to extension (${type}) ${text}`);

    switch (type) {
      case "internal":
        return this.handleInternal(message);
      case "link":
        return this.dispatchCommand({ namespace: "open", subcommand: text });
      case "command":
        return this.handleCommand(text);
      case "text":
        return text ? this.sendTextMessage(text) : null;
      case "thread_reply":
        return this.sendThreadReply(text);
    }
  };

  handleReverseCommands = (uiMessage: UIMessage) => {
    // Reverse commands are slash commands fired by other Slack users
    // For example, `/live request` requests someone to host a session
    const { currentUser, messages } = uiMessage;
    let handledMessages = {};

    Object.keys(messages).forEach(ts => {
      // Any of these messages might be reverse commands
      const { text, userId } = messages[ts];
      const notCurrentUser = currentUser.id !== userId;
      let textHTML = messages[ts].textHTML;

      if (this.isValidReverseCommand(text) && notCurrentUser) {
        if (text === "/live request") {
          const confirmation = `<a href="#" onclick="sendCommand('/live share'); return false;">Accept</a>`;
          textHTML = `${str.LIVE_REQUEST_MESSAGE} ${confirmation}`;
        }
      }

      handledMessages[ts] = {
        ...messages[ts],
        textHTML
      };
    });

    return {
      ...uiMessage,
      messages: handledMessages
    };
  };

  sendToUI = (uiMessage: UIMessage) => {
    if (!this.isUIReady) {
      this.pendingMessage = uiMessage;
    } else {
      const { messages } = uiMessage;
      const size = Object.keys(messages).length;
      Logger.log(`Sending to webview: ${size} messages`);

      // Handle markdown
      const mdMessages = markdownTransform(uiMessage);

      // Handle reverse slash commands
      // Since this overwrites the textHTML field, it should happen
      // after the markdown
      const message = this.handleReverseCommands(mdMessages);

      // Send to UI after markdown
      this.ui.update(message);
      this.pendingMessage = null;
    }
  };
}

export default ViewController;
