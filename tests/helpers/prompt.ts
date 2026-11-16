import { spyOn } from "bun:test";
import { PassThrough } from "node:stream";
import * as promptAdapter from "../../src/adapters/prompt/index.ts";

/** Makes `createPrompt` give a fake that picks `value` and keeps each request. The spy goes in `spies`. */
export function fakePick(
  spies: { mockRestore(): void }[],
  value: string,
): promptAdapter.PickRequest[] {
  const requests: promptAdapter.PickRequest[] = [];
  spies.push(
    spyOn(promptAdapter, "createPrompt").mockImplementation(() => ({
      pick: (request) => {
        requests.push(request);
        return Promise.resolve(value);
      },
    })),
  );
  return requests;
}

/** Makes `createMultiPrompt` give a fake that picks `values` and keeps each request. The spy goes in `spies`. */
export function fakePickMany(
  spies: { mockRestore(): void }[],
  values: string[],
): promptAdapter.PickRequest[] {
  const requests: promptAdapter.PickRequest[] = [];
  spies.push(
    spyOn(promptAdapter, "createMultiPrompt").mockImplementation(() => ({
      pickMany: (request) => {
        requests.push(request);
        return Promise.resolve(values);
      },
    })),
  );
  return requests;
}

/** Makes `createConfirm` give a fake that answers `answer` and keeps each question. The spy goes in `spies`. */
export function fakeConfirm(
  spies: { mockRestore(): void }[],
  answer: boolean,
): string[] {
  const messages: string[] = [];
  spies.push(
    spyOn(promptAdapter, "createConfirm").mockImplementation(() => ({
      confirm: (message) => {
        messages.push(message);
        return Promise.resolve(answer);
      },
    })),
  );
  return messages;
}

/**
 * Makes `createPrompt`, `createMultiPrompt` and `createConfirm` give the real adapters on fake streams, with `keys` typed in,
 * so it never reads the real stdin. The spy goes in `spies`.
 */
export function fakeKeys(
  spies: { mockRestore(): void }[],
  keys: string[],
): void {
  const real = promptAdapter.createPrompt;
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  for (const key of keys) input.write(key);
  const realMulti = promptAdapter.createMultiPrompt;
  const realConfirm = promptAdapter.createConfirm;
  spies.push(
    spyOn(promptAdapter, "createPrompt").mockImplementation((options) =>
      real({ ...options, input, output }),
    ),
    spyOn(promptAdapter, "createMultiPrompt").mockImplementation((options) =>
      realMulti({ ...options, input, output }),
    ),
    spyOn(promptAdapter, "createConfirm").mockImplementation((options) =>
      realConfirm({ ...options, input, output }),
    ),
  );
}
