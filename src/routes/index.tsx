import { createFileRoute } from "@tanstack/react-router";
import { Cobre } from "@/components/synth/cobre";

export const Route = createFileRoute("/")({
  component: Cobre,
});
