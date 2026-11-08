// the desktop app: a window onto what the agent's broadcasting on this machine.
// it's only the frontend - the agent stays its own process, so nothing the
// window does (a freeze, a slow render, quitting) can hold up capture. the app
// starts it if it isn't already running, and the page reads its stream the
// same way the website did (web/src/db.ts)
package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// the web app's build - wails.json's frontend:build puts it here
//
//go:embed all:frontend/dist
var assets embed.FS

func main() {
	agent := &agentProcess{}
	err := wails.Run(&options.App{
		Title:            "ultimate packet inspector",
		Width:            1440,
		Height:           900,
		MinWidth:         760,
		MinHeight:        500,
		BackgroundColour: &options.RGBA{R: 0x13, G: 0x1c, B: 0x29, A: 255}, // --bg in web/src/colors.css
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        agent.start,
		OnShutdown:       agent.stop,
	})
	if err != nil {
		log.Fatal(err)
	}
}
