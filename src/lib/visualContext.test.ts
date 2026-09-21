import assert from "node:assert/strict";
import { useAppStore } from "../store";
import { roomModel } from "./roomModel";
import { perception } from "./perceptionLiveness";

function reset() {
  roomModel.reset("room");
  perception.reset(1);
  perception.setChannel("room", 1);
  perception.setCapabilities({ visionCaptureSupported: true });
  useAppStore.setState({
    visualSnapshotUrl: null,
    visualContextTags: [],
    activeVisualSnapshotId: null,
    visualContextRevision: 0,
    visualSnapshotHistory: [],
    pinnedMemories: [],
  });
}

reset();
useAppStore.getState().setVisualSnapshot("data:first", ["first scene"], "manual");
const firstId = useAppStore.getState().activeVisualSnapshotId!;
useAppStore.getState().setVisualSnapshot("data:second", ["second scene"], "manual");
const secondId = useAppStore.getState().activeVisualSnapshotId!;
useAppStore.getState().removeVisualSnapshot(firstId);
assert.equal(useAppStore.getState().activeVisualSnapshotId, secondId, "deleting a non-active archive does not disturb the active visual");
assert.equal(useAppStore.getState().visualSnapshotUrl, "data:second");

useAppStore.getState().removeVisualSnapshot(secondId);
assert.equal(useAppStore.getState().activeVisualSnapshotId, null, "active delete clears active identity");
assert.equal(useAppStore.getState().visualSnapshotUrl, null, "active delete clears screenshot context");
assert.deepEqual(useAppStore.getState().visualContextTags, [], "active delete clears textual visual context");
assert.equal(roomModel.getState()?.vision, undefined, "Room Model current vision is surgically invalidated");
const visionLane = perception.getSummary(Date.now()).lanes.vision;
assert.equal(visionLane.lastInputAt, undefined, "Perception no longer reports the deleted frame as current input");
assert.equal(visionLane.lastValidOutputAt, undefined, "Perception no longer reports deleted semantic output");
assert.equal(useAppStore.getState().roomState?.vision, undefined, "Room Model store mirror is invalidated synchronously");
assert.equal(useAppStore.getState().perceptionSummary?.lanes.vision.lastInputAt, undefined, "Perception store mirror is invalidated synchronously");

reset();
useAppStore.getState().addPinnedMemory({ type: "visual", content: "kept", label: "Pinned visual", timestamp: 1, imageUrl: "data:pinned" });
useAppStore.getState().setVisualSnapshot("data:active", ["active scene"], "manual");
const requestRevision = useAppStore.getState().visualContextRevision;
useAppStore.getState().clearVisualSnapshotHistory();
assert.equal(useAppStore.getState().visualSnapshotHistory.length, 0, "Clear All empties visual history");
assert.equal(useAppStore.getState().visualSnapshotUrl, null, "Clear All forgets active screenshot");
assert.equal(useAppStore.getState().pinnedMemories.length, 1, "separately pinned visual memory is preserved");
assert.notEqual(useAppStore.getState().visualContextRevision, requestRevision, "clear invalidates in-flight visual request identity");

reset();
useAppStore.getState().setVisualSnapshot("data:pending", ["pending scene"], "manual");
const staleRevision = useAppStore.getState().visualContextRevision;
let resolveLate!: (tags: string[]) => void;
const lateProvider = new Promise<string[]>((resolve) => { resolveLate = resolve; });
const completion = lateProvider.then((tags) => {
  if (useAppStore.getState().visualContextRevision !== staleRevision) return;
  useAppStore.getState().setVisualSnapshot("data:pending", tags, "manual");
});
useAppStore.getState().clearVisualSnapshotHistory();
resolveLate(["late resurrection attempt"]);
await completion;
assert.equal(useAppStore.getState().visualSnapshotUrl, null, "late provider completion cannot resurrect a cleared visual");
assert.deepEqual(useAppStore.getState().visualContextTags, [], "late provider text is discarded after invalidation");

reset();
useAppStore.getState().setVisualSnapshot("data:ephemeral", ["ephemeral"], "manual", undefined, true);
assert.equal(useAppStore.getState().activeVisualSnapshotId, null, "skipHistory visual has no archive identity");
assert.equal(useAppStore.getState().visualSnapshotHistory.length, 0);
assert.equal(useAppStore.getState().visualSnapshotUrl, "data:ephemeral", "skipHistory visual is still active context");
useAppStore.getState().clearActiveVisualContext();
assert.equal(useAppStore.getState().visualSnapshotUrl, null, "atomic invalidation also clears identity-less active context");

console.log("Visual active-context integrity scenarios passed");
