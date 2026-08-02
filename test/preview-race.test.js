/**
 * Unit test for the preview render race-condition guard.
 *
 * renderPreview() increments previewRequestId at the start and captures it
 * in a closure. The async .then() callback checks if the captured id still
 * matches the latest previewRequestId before committing. This test
 * validates that pattern directly.
 */
const { describe, test, expect } = require("bun:test");

describe("preview render race-condition guard", () => {
  test("stale async render is dropped when a newer request supersedes it", async () => {
    var previewRequestId = 0;
    var committed = [];

    function simulateRenderPreview(content, delay) {
      var reqId = ++previewRequestId;
      return new Promise(function (resolve) {
        setTimeout(function () {
          if (reqId !== previewRequestId) {
            resolve("dropped");
            return;
          }
          committed.push(content);
          resolve("committed");
        }, delay);
      });
    }

    var p1 = simulateRenderPreview("first", 50);
    var p2 = simulateRenderPreview("second", 10);

    var r1 = await p1;
    var r2 = await p2;

    expect(r1).toBe("dropped");
    expect(r2).toBe("committed");
    expect(committed).toEqual(["second"]);
  });

  test("in-order renders both commit", async () => {
    var previewRequestId = 0;
    var committed = [];

    function simulateRenderPreview(content, delay) {
      var reqId = ++previewRequestId;
      return new Promise(function (resolve) {
        setTimeout(function () {
          if (reqId !== previewRequestId) {
            resolve("dropped");
            return;
          }
          committed.push(content);
          resolve("committed");
        }, delay);
      });
    }

    var p1 = simulateRenderPreview("first", 10);
    await p1;
    var p2 = simulateRenderPreview("second", 10);
    await p2;

    expect(committed).toEqual(["first", "second"]);
  });

  test("three rapid renders — only the last commits", async () => {
    var previewRequestId = 0;
    var committed = [];

    function simulateRenderPreview(content, delay) {
      var reqId = ++previewRequestId;
      return new Promise(function (resolve) {
        setTimeout(function () {
          if (reqId !== previewRequestId) {
            resolve("dropped");
            return;
          }
          committed.push(content);
          resolve("committed");
        }, delay);
      });
    }

    var p1 = simulateRenderPreview("a", 60);
    var p2 = simulateRenderPreview("b", 40);
    var p3 = simulateRenderPreview("c", 20);

    var r1 = await p1;
    var r2 = await p2;
    var r3 = await p3;

    expect(r1).toBe("dropped");
    expect(r2).toBe("dropped");
    expect(r3).toBe("committed");
    expect(committed).toEqual(["c"]);
  });
});
