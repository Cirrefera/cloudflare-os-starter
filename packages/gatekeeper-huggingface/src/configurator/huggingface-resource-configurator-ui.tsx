import { Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";

type UI = { normalizeResourceUrl(raw: string): Promise<string> };
type Values = { url?: string | null };

export default {
  initial: {},
  initialValuesFromResourceUrl: ({ resourceUrl }) => ({ url: resourceUrl }),
  isReady: ({ values }) => /^https:\/\/huggingface\.co\/(models|datasets|spaces)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test((values.url ?? "").trim()),
  resourceUrl: ({ values, ui }) => ui.normalizeResourceUrl(values.url ?? ""),
  render({ values, setValues }) {
    return <Section>
      <Field label="Repository URL" description="Choose a model, dataset, or Space your connected Hugging Face account can access.">
        <TextInput name="url" value={values.url} placeholder="https://huggingface.co/datasets/namespace/repository" onChange={url => setValues({ url })} />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<UI, Values>;
