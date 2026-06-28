import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
} from "@earendil-works/pi-ai";
import { errorAssistantMessage, eventPartial } from "./stream-events.ts";

export class StreamWriter {
	private startEvent: AssistantMessageEvent | undefined;
	private startPushed = false;
	closed = false;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		private readonly model: Model<Api>,
	) {}

	rememberStart(event: AssistantMessageEvent): void {
		this.startEvent ??= event;
	}

	push(event: AssistantMessageEvent): void {
		if (event.type === "start") {
			if (!this.startPushed) {
				this.stream.push(this.startEvent ?? event);
				this.startPushed = true;
			}
			return;
		}
		if (!this.startPushed) {
			this.stream.push(
				this.startEvent ?? {
					type: "start",
					partial: eventPartial(event, this.model),
				},
			);
			this.startPushed = true;
		}
		this.stream.push(event);
	}

	pushError(message: string, reason: "error" | "aborted" = "error"): void {
		this.push({
			type: "error",
			reason,
			error: errorAssistantMessage(this.model, message, reason),
		});
	}

	end(): void {
		this.closed = true;
		this.stream.end();
	}
}
