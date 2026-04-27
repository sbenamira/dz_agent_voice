-- Migration v5 : table products + colonnes calls pour Gemini Live

-- Table produits e-commerce (une ligne par produit/boutique)
create table if not exists products (
  id uuid default gen_random_uuid() primary key,
  workspace_id uuid references workspaces(id),
  shop_name text not null,
  product_name text not null,
  price integer not null,
  delivery_delay text not null,
  guarantee text default '7 jours',
  faq_ar text,
  faq_fr text,
  created_at timestamp default now()
);

-- Colonnes supplémentaires sur calls pour le tracking v5
alter table calls
  add column if not exists language text,
  add column if not exists outcome text,
  add column if not exists product_id uuid references products(id);
