package cli

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "horcrux",
	Short: "Horcrux is a container image multi-source synchronization tool",
	Long: `A robust tool for synchronizing container images across different registries,
supporting multi-arch manifest merging and secure credential management.`,
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	// Root flags if needed
}
