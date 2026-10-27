defmodule JsTsParser.MixProject do
  use Mix.Project

  def project do
    [app: :js_ts_parser, version: "0.1.0", elixir: "~> 1.14", deps: [{:jason, "~> 1.2"}]]
  end

  def application, do: [extra_applications: [:crypto]]
end
