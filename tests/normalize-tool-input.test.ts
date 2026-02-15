import { describe, it, expect } from "vitest";
import { normalizeToolInput } from "../src/utils/normalize-tool-input.js";

describe("normalizeToolInput", () => {
  it("does not modify non-target tools", () => {
    expect(normalizeToolInput("Read", { file_path: "/d/x.ipynb" }, "win32")).toEqual({
      file_path: "/d/x.ipynb",
    });
  });

  it("normalizes MSYS drive paths for NotebookEdit on Windows", () => {
    expect(normalizeToolInput("NotebookEdit", { file_path: "/d/nb.ipynb" }, "win32")).toEqual({
      file_path: "D:\\nb.ipynb",
    });
    expect(
      normalizeToolInput("NotebookEdit", { file_path: "/mnt/c/dir/nb.ipynb" }, "win32")
    ).toEqual({
      file_path: "C:\\dir\\nb.ipynb",
    });
  });

  it("normalizes /cygdrive and MSYS UNC paths for NotebookEdit on Windows", () => {
    expect(
      normalizeToolInput("NotebookEdit", { file_path: "/cygdrive/d/nb.ipynb" }, "win32")
    ).toEqual({
      file_path: "D:\\nb.ipynb",
    });
    expect(
      normalizeToolInput("NotebookEdit", { file_path: "//server/share/dir/nb.ipynb" }, "win32")
    ).toEqual({
      file_path: "\\\\server\\share\\dir\\nb.ipynb",
    });
    // Avoid mis-classifying double-slash drive paths as UNC.
    expect(normalizeToolInput("NotebookEdit", { file_path: "//d/nb.ipynb" }, "win32")).toEqual({
      file_path: "//d/nb.ipynb",
    });
  });

  it("does not modify on non-Windows platforms", () => {
    expect(normalizeToolInput("NotebookEdit", { file_path: "/d/nb.ipynb" }, "linux")).toEqual({
      file_path: "/d/nb.ipynb",
    });
  });
});
