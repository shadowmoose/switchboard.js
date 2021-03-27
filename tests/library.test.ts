import {Switchboard} from "../";

describe("Base tests", () => {
  it("should create Library", () => {
    expect(Switchboard).not.toBeUndefined();
    expect(Switchboard.makeSeed()).toBeTruthy();
  });
});
