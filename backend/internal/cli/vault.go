package cli

import (
	"fmt"
	"log"
	"os"

	"github.com/guoxudong/horcrux/internal/vault"
	"github.com/spf13/cobra"
)

var (
	credName     string
	credRegistry string
	credUser     string
	credPass     string
)

var vaultCmd = &cobra.Command{
	Use:   "vault",
	Short: "Manage credentials in the vault",
}

var vaultAddCmd = &cobra.Command{
	Use:   "add",
	Short: "Add a new credential",
	Run: func(cmd *cobra.Command, args []string) {
		if credName == "" || credRegistry == "" || credUser == "" || credPass == "" {
			fmt.Println("Error: all flags are required (name, registry, user, pass)")
			return
		}

		key := os.Getenv("HORCRUX_SECRET")
		if key == "" {
			key = "12345678901234567890123456789012"
		}

		v, err := vault.NewVault("data/vault.enc", key)
		if err != nil {
			log.Fatalf("Failed to initialize vault: %v", err)
		}

		creds, _ := v.LoadCredentials()
		newCred := vault.Credential{
			ID:       fmt.Sprintf("cred_%d", len(creds)+1),
			Name:     credName,
			Registry: credRegistry,
			Username: credUser,
			Password: credPass,
		}

		creds = append(creds, newCred)
		if err := v.SaveCredentials(creds); err != nil {
			log.Fatalf("Failed to save credentials: %v", err)
		}

		fmt.Printf("Successfully added credential: %s (%s)\n", credName, credRegistry)
	},
}

var vaultListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all credentials",
	Run: func(cmd *cobra.Command, args []string) {
		key := os.Getenv("HORCRUX_SECRET")
		if key == "" {
			key = "12345678901234567890123456789012"
		}

		v, err := vault.NewVault("data/vault.enc", key)
		if err != nil {
			log.Fatalf("Failed to initialize vault: %v", err)
		}

		creds, err := v.LoadCredentials()
		if err != nil {
			log.Fatalf("Failed to load credentials: %v", err)
		}

		fmt.Printf("%-20s %-30s %-20s\n", "NAME", "REGISTRY", "USERNAME")
		fmt.Println("----------------------------------------------------------------------")
		for _, c := range creds {
			fmt.Printf("%-20s %-30s %-20s\n", c.Name, c.Registry, c.Username)
		}
	},
}

func init() {
	vaultAddCmd.Flags().StringVarP(&credName, "name", "n", "", "Credential name")
	vaultAddCmd.Flags().StringVarP(&credRegistry, "registry", "r", "", "Registry URL")
	vaultAddCmd.Flags().StringVarP(&credUser, "user", "u", "", "Username")
	vaultAddCmd.Flags().StringVarP(&credPass, "pass", "p", "", "Password")

	vaultCmd.AddCommand(vaultAddCmd)
	vaultCmd.AddCommand(vaultListCmd)
	rootCmd.AddCommand(vaultCmd)
}
